import { childLogger } from '../logger.js';
import type { HealthRepository } from '../database/healthRepository.js';
import { SettingKey, type SettingsRepository } from '../database/settingsRepository.js';
import type { RateSnapshot } from '../types/exchangeRate.js';
import { APP_VERSION } from '../version.js';

const log = childLogger('health');

/**
 * 서비스 건강 상태 추적.
 *
 * 요구사항 6.3:
 *  - 연속 실패가 임계치에 도달하면 **한 번만** 경고를 보낸다.
 *  - 실패가 계속돼도 매분 반복하지 않는다.
 *  - 복구되면 **한 번만** 복구 메시지를 보낸다.
 *
 * "경고를 이미 보냈는가" 는 재시작 후에도 유지돼야 하므로 app_settings 에 저장한다.
 * (재시작마다 경고가 다시 나가면 알림 스팸이 된다.)
 */

export interface HealthSnapshot {
  readonly startedAt: string;
  readonly uptimeMs: number;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly lastFailureReason: string | null;
  readonly consecutiveFailures: number;
  readonly totalSuccesses: number;
  readonly totalFailures: number;
  readonly alertActive: boolean;
  readonly version: string;
}

/** 실패/복구 알림이 필요한지에 대한 판단 결과. */
export type AlertAction = 'none' | 'send-failure-alert' | 'send-recovery';

export interface HealthServiceDeps {
  readonly settings: SettingsRepository;
  readonly health: HealthRepository;
  readonly failureAlertThreshold: number;
}

export class HealthService {
  readonly #settings: SettingsRepository;
  readonly #health: HealthRepository;
  readonly #threshold: number;
  readonly #startedAt: Date;

  #lastSuccessAt: string | null = null;
  #lastFailureAt: string | null = null;
  #lastFailureReason: string | null = null;
  #consecutiveFailures = 0;
  #totalSuccesses = 0;
  #totalFailures = 0;

  constructor(deps: HealthServiceDeps) {
    this.#settings = deps.settings;
    this.#health = deps.health;
    this.#threshold = deps.failureAlertThreshold;
    this.#startedAt = new Date();
  }

  get startedAt(): Date {
    return this.#startedAt;
  }

  get consecutiveFailures(): number {
    return this.#consecutiveFailures;
  }

  get lastSuccessAt(): string | null {
    return this.#lastSuccessAt;
  }

  get lastFailureAt(): string | null {
    return this.#lastFailureAt;
  }

  /** 임계치를 넘어 경고가 발송된 상태인가 (재시작 후에도 유지). */
  get alertActive(): boolean {
    return this.#settings.getBoolean(SettingKey.FAILURE_ALERT_SENT, false);
  }

  /**
   * 수집 성공을 기록하고, 복구 알림이 필요한지 반환한다.
   */
  recordSuccess(snapshot: RateSnapshot): AlertAction {
    const wasFailing = this.#consecutiveFailures > 0;
    const alertWasActive = this.alertActive;

    this.#lastSuccessAt = snapshot.collectedAt;
    this.#consecutiveFailures = 0;
    this.#totalSuccesses += 1;

    if (alertWasActive) {
      this.#settings.setBoolean(SettingKey.FAILURE_ALERT_SENT, false);
      this.#health.record('scraper', 'info', '연속 실패에서 복구되었습니다');
      log.info(
        { event: 'service_recovered', rate: snapshot.rate },
        '서비스 복구 — 복구 알림을 1회 발송합니다',
      );
      return 'send-recovery';
    }

    if (wasFailing) {
      // 임계치에 도달하기 전에 회복된 경우 — 알림 없이 로그만 남긴다.
      log.info({ event: 'transient_failure_recovered' }, '일시적 실패에서 회복');
    }

    return 'none';
  }

  /**
   * 수집 실패를 기록하고, 경고 알림이 필요한지 반환한다.
   * 임계치에 "처음 도달했을 때" 한 번만 'send-failure-alert' 를 반환한다.
   */
  recordFailure(error: Error, occurredAtIso = new Date().toISOString()): AlertAction {
    this.#consecutiveFailures += 1;
    this.#totalFailures += 1;
    this.#lastFailureAt = occurredAtIso;
    this.#lastFailureReason = `${error.name}: ${error.message}`;

    const reachedThreshold = this.#consecutiveFailures >= this.#threshold;
    if (!reachedThreshold || this.alertActive) {
      log.warn(
        {
          event: 'failure_recorded',
          consecutiveFailures: this.#consecutiveFailures,
          threshold: this.#threshold,
          alertActive: this.alertActive,
        },
        '수집 실패 기록 (알림 억제 중)',
      );
      return 'none';
    }

    this.#settings.setBoolean(SettingKey.FAILURE_ALERT_SENT, true);
    this.#health.record(
      'scraper',
      'error',
      `연속 ${this.#consecutiveFailures}회 실패 — 경고 발송`,
      occurredAtIso,
    );
    log.error(
      { event: 'failure_alert_sent', consecutiveFailures: this.#consecutiveFailures },
      '연속 실패 임계치 도달 — 경고를 1회 발송합니다',
    );
    return 'send-failure-alert';
  }

  /** `/yen-status` 용 상태 스냅샷. */
  snapshot(now: Date = new Date()): HealthSnapshot {
    return {
      startedAt: this.#startedAt.toISOString(),
      uptimeMs: now.getTime() - this.#startedAt.getTime(),
      lastSuccessAt: this.#lastSuccessAt,
      lastFailureAt: this.#lastFailureAt,
      lastFailureReason: this.#lastFailureReason,
      consecutiveFailures: this.#consecutiveFailures,
      totalSuccesses: this.#totalSuccesses,
      totalFailures: this.#totalFailures,
      alertActive: this.alertActive,
      version: APP_VERSION,
    };
  }

  /**
   * 재시작 직후 마지막 성공 시각을 DB 값으로 복원한다.
   * (프로세스 메모리는 비어 있지만 `/yen-status` 는 의미 있는 값을 보여줘야 한다.)
   */
  hydrateFromLastRecord(lastCollectedAt: string | null): void {
    if (lastCollectedAt !== null && this.#lastSuccessAt === null) {
      this.#lastSuccessAt = lastCollectedAt;
    }
  }

  /** 컴포넌트 이벤트 기록 위임. */
  record(
    component: Parameters<HealthRepository['record']>[0],
    level: Parameters<HealthRepository['record']>[1],
    message: string,
  ): void {
    this.#health.record(component, level, message);
  }
}
