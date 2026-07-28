import { childLogger } from '../logger.js';
import type { AlertRepository, RateAlert } from '../database/alertRepository.js';
import type { HealthRepository } from '../database/healthRepository.js';
import type { RateSnapshot } from '../types/exchangeRate.js';
import { toCents } from '../utils/money.js';

const log = childLogger('alerts');

/**
 * 목표 환율 알림 평가.
 *
 * 스팸 방지가 이 서비스의 핵심 책임이다.
 *
 * 순진하게 `rate <= target` 만 보면, 환율이 목표선 근처에서 흔들릴 때
 * 매분 멘션이 날아간다. (1분 주기이므로 하루 1,440번까지 가능하다)
 *
 * 그래서 각 알림은 무장(armed) 상태를 가진다:
 *
 *   armed=1  ─── 조건 충족 ──▶  발송 + armed=0
 *      ▲                              │
 *      └──── 목표선에서 margin 이상 ────┘
 *            벗어나면 재무장
 *
 * 예) 목표 "940 이하", margin 1.0
 *   939.5 → 발송, 무장 해제
 *   939.8 → 조건은 맞지만 무장 해제 상태라 조용함
 *   940.5 → 아직 재무장 안 됨 (940 + 1.0 = 941 미만)
 *   941.2 → 재무장. 다음에 940 이하로 내려가면 다시 발송
 */

export interface AlertTrigger {
  readonly alert: RateAlert;
  readonly rate: number;
  readonly snapshot: RateSnapshot;
}

export interface AlertServiceDeps {
  readonly alerts: AlertRepository;
  readonly health: HealthRepository;
  /**
   * 재무장에 필요한 여유폭(KRW).
   * 0 이면 조건을 벗어나는 즉시 재무장한다 (경계선 근처에서 반복 발송 위험).
   */
  readonly rearmMarginKrw: number;
}

export class AlertService {
  readonly #alerts: AlertRepository;
  readonly #health: HealthRepository;
  readonly #marginCents: number;

  constructor(deps: AlertServiceDeps) {
    this.#alerts = deps.alerts;
    this.#health = deps.health;
    this.#marginCents = Math.max(0, toCents(deps.rearmMarginKrw));
  }

  /**
   * 현재 환율로 모든 활성 알림을 평가한다.
   *
   * 발동한 알림은 DB 상태(armed / trigger_count)를 즉시 갱신하고 목록으로 반환한다.
   * 실제 메시지 전송은 호출부(notificationService)가 담당한다.
   *
   * 예외를 던지지 않는다 — 알림 오류가 수집 루프를 멈추면 안 된다.
   */
  evaluate(snapshot: RateSnapshot, now: Date = new Date()): AlertTrigger[] {
    let alerts: RateAlert[];
    try {
      alerts = this.#alerts.findEnabled();
    } catch (error) {
      log.error({ event: 'alert_load_failed', err: error }, '알림 목록 조회 실패');
      return [];
    }

    if (alerts.length === 0) return [];

    const rateCents = toCents(snapshot.rate);
    const triggers: AlertTrigger[] = [];

    for (const alert of alerts) {
      try {
        const targetCents = toCents(alert.targetRate);
        const conditionMet =
          alert.direction === 'below' ? rateCents <= targetCents : rateCents >= targetCents;

        if (conditionMet) {
          if (!alert.armed) continue; // 이미 발송함 — 재무장 전까지 조용히
          this.#alerts.markTriggered(alert.id, snapshot.rate, now.toISOString());
          triggers.push({ alert, rate: snapshot.rate, snapshot });
          log.info(
            {
              event: 'alert_triggered',
              alertId: alert.id,
              direction: alert.direction,
              target: alert.targetRate,
              rate: snapshot.rate,
              once: alert.once,
            },
            '환율 알림 발동',
          );
          this.#health.record(
            'discord',
            'info',
            `알림 #${alert.id} 발동: ${snapshot.rate} (목표 ${alert.direction === 'below' ? '≤' : '≥'} ${alert.targetRate})`,
          );
          continue;
        }

        // 조건을 벗어난 상태 — 목표선에서 충분히 멀어졌으면 재무장한다.
        if (alert.armed) continue;

        const clearedCents =
          alert.direction === 'below'
            ? rateCents >= targetCents + this.#marginCents
            : rateCents <= targetCents - this.#marginCents;

        if (clearedCents) {
          this.#alerts.setArmed(alert.id, true);
          log.debug(
            { event: 'alert_rearmed', alertId: alert.id, rate: snapshot.rate },
            '알림 재무장',
          );
        }
      } catch (error) {
        log.error({ event: 'alert_eval_failed', alertId: alert.id, err: error }, '알림 평가 실패');
      }
    }

    return triggers;
  }
}
