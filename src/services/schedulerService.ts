import cron, { type ScheduledTask } from 'node-cron';
import { childLogger } from '../logger.js';
import { DISPLAY_TIME_ZONE } from '../utils/time.js';
import type { RetentionService } from './retentionService.js';

const log = childLogger('scheduler');

export interface SchedulerDeps {
  /** 매 주기 실행할 작업. 절대 예외를 던지지 않아야 한다. */
  readonly onTick: () => Promise<void>;
  readonly intervalSeconds: number;
  readonly retention: RetentionService;
  /** 일일 정리 작업 실행 시각 (cron 표현식, Asia/Seoul 기준). 기본 매일 04:10 */
  readonly retentionCron?: string;
}

/**
 * 스케줄러.
 *
 * 왜 수집에 `setInterval` 이 아니라 자기 보정 `setTimeout` 인가:
 *  - `setInterval` 은 콜백이 오래 걸리면 호출이 밀려 쌓이거나 드리프트가 누적된다.
 *  - 여기서는 "다음 실행 절대시각" 을 계산해 매번 남은 시간만큼만 기다린다.
 *    이렇게 하면 수집이 20초 걸려도 다음 실행은 여전히 정각 경계에 맞는다.
 *
 * 일일 보존 작업은 특정 시각에 돌아야 하므로 node-cron 을 쓴다.
 */
export class SchedulerService {
  readonly #onTick: () => Promise<void>;
  readonly #intervalMs: number;
  readonly #retention: RetentionService;
  readonly #retentionCron: string;

  #timer: NodeJS.Timeout | null = null;
  #cronTask: ScheduledTask | null = null;
  #nextRunAtMs: number | null = null;
  #running = false;
  #stopping = false;

  constructor(deps: SchedulerDeps) {
    this.#onTick = deps.onTick;
    this.#intervalMs = Math.max(1, deps.intervalSeconds) * 1_000;
    this.#retention = deps.retention;
    this.#retentionCron = deps.retentionCron ?? '10 4 * * *';
  }

  get isRunning(): boolean {
    return this.#running;
  }

  /** 다음 수집 예정 시각 (ISO). 정지 상태면 null. */
  nextRunAt(): string | null {
    return this.#nextRunAtMs === null ? null : new Date(this.#nextRunAtMs).toISOString();
  }

  /** 스케줄을 시작한다. 첫 수집은 호출부가 별도로 즉시 실행한다. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#stopping = false;

    this.#scheduleNext(Date.now() + this.#intervalMs);

    this.#cronTask = cron.schedule(
      this.#retentionCron,
      () => {
        this.#retention.run();
      },
      { timezone: DISPLAY_TIME_ZONE },
    );

    log.info(
      {
        event: 'scheduler_started',
        intervalSeconds: this.#intervalMs / 1_000,
        retentionCron: this.#retentionCron,
        nextRunAt: this.nextRunAt(),
      },
      '스케줄러 시작',
    );
  }

  /** 새 작업 예약을 중단한다. 진행 중인 작업은 건드리지 않는다. */
  stop(): void {
    if (!this.#running) return;
    this.#stopping = true;
    this.#running = false;

    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#cronTask !== null) {
      this.#cronTask.stop();
      this.#cronTask = null;
    }
    this.#nextRunAtMs = null;

    log.info({ event: 'scheduler_stopped' }, '스케줄러 정지 — 새 작업을 예약하지 않습니다');
  }

  /** 드리프트를 보정하며 다음 실행을 예약한다. */
  #scheduleNext(targetMs: number): void {
    if (!this.#running || this.#stopping) return;

    this.#nextRunAtMs = targetMs;
    const delay = Math.max(0, targetMs - Date.now());

    this.#timer = setTimeout(() => {
      void this.#tick(targetMs);
    }, delay);
    this.#timer.unref?.();
  }

  async #tick(scheduledForMs: number): Promise<void> {
    if (!this.#running || this.#stopping) return;

    try {
      await this.#onTick();
    } catch (error) {
      // onTick 은 예외를 던지지 않도록 설계됐지만, 방어적으로 잡아 루프를 지킨다.
      log.error(
        { event: 'scheduler_tick_failed', err: error },
        '스케줄 작업 실패 (루프는 계속됩니다)',
      );
    }

    // 다음 경계 계산: 작업이 오래 걸려 여러 주기를 넘겼다면 넘긴 만큼 건너뛴다.
    const now = Date.now();
    let next = scheduledForMs + this.#intervalMs;
    if (next <= now) {
      const missed = Math.ceil((now - scheduledForMs) / this.#intervalMs);
      next = scheduledForMs + missed * this.#intervalMs;
      log.warn(
        {
          event: 'scheduler_drift_corrected',
          missedIntervals: missed - 1,
          nextRunAt: new Date(next).toISOString(),
        },
        '수집이 주기보다 오래 걸려 일정을 재조정했습니다',
      );
    }

    this.#scheduleNext(next);
  }
}
