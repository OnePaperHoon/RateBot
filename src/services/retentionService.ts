import { childLogger, LogEvent } from '../logger.js';
import type { HealthRepository } from '../database/healthRepository.js';
import type { RateRepository } from '../database/rateRepository.js';
import { SettingKey, type SettingsRepository } from '../database/settingsRepository.js';
import { isoDaysAgo } from '../utils/time.js';

const log = childLogger('retention');

export interface RetentionResult {
  readonly deletedRates: number;
  readonly deletedHealthEvents: number;
  readonly cutoffIso: string;
  readonly durationMs: number;
  readonly vacuumed: boolean;
}

export interface RetentionServiceDeps {
  readonly rates: RateRepository;
  readonly health: HealthRepository;
  readonly settings: SettingsRepository;
  readonly retentionDays: number;
  /** 이만큼 이상 삭제됐을 때만 VACUUM 을 실행한다 (SD 카드 쓰기 절약). */
  readonly vacuumThreshold?: number;
}

/**
 * 데이터 보존 정책 (요구사항 5.4).
 *
 * - 기본 365일보다 오래된 분 단위 데이터를 삭제한다.
 * - health_events 도 같은 기준으로 정리한다.
 * - 하루 한 번 실행된다 (schedulerService 가 호출).
 * - 라즈베리파이 SD 카드 수명을 고려해 VACUUM 은 대량 삭제 시에만 수행한다.
 */
export class RetentionService {
  readonly #rates: RateRepository;
  readonly #health: HealthRepository;
  readonly #settings: SettingsRepository;
  readonly #retentionDays: number;
  readonly #vacuumThreshold: number;

  constructor(deps: RetentionServiceDeps) {
    this.#rates = deps.rates;
    this.#health = deps.health;
    this.#settings = deps.settings;
    this.#retentionDays = deps.retentionDays;
    this.#vacuumThreshold = deps.vacuumThreshold ?? 1_000;
  }

  get retentionDays(): number {
    return this.#retentionDays;
  }

  /** 마지막 실행 시각 (ISO). 없으면 null. */
  lastRunAt(): string | null {
    return this.#settings.get(SettingKey.LAST_RETENTION_AT);
  }

  /** 보존 기간을 넘긴 데이터를 정리한다. 예외를 던지지 않는다. */
  run(now: Date = new Date()): RetentionResult {
    const startedAt = Date.now();
    const cutoffIso = isoDaysAgo(this.#retentionDays, now);

    let deletedRates = 0;
    let deletedHealthEvents = 0;
    let vacuumed = false;

    try {
      deletedRates = this.#rates.deleteOlderThan(cutoffIso);
      deletedHealthEvents = this.#health.deleteOlderThan(cutoffIso);

      if (deletedRates >= this.#vacuumThreshold) {
        this.#rates.vacuum();
        vacuumed = true;
      }

      this.#settings.set(SettingKey.LAST_RETENTION_AT, now.toISOString());
    } catch (error) {
      log.error({ event: 'retention_failed', err: error }, '데이터 정리 실패 (다음 주기에 재시도)');
      this.#health.record(
        'database',
        'error',
        `보존 정책 실행 실패: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const durationMs = Date.now() - startedAt;
    log.info(
      {
        event: LogEvent.RETENTION_COMPLETED,
        deletedRates,
        deletedHealthEvents,
        retentionDays: this.#retentionDays,
        cutoffIso,
        vacuumed,
        durationMs,
      },
      '데이터 보존 정책 실행 완료',
    );

    return { deletedRates, deletedHealthEvents, cutoffIso, durationMs, vacuumed };
  }
}
