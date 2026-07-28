import type { Database as SqliteDatabase, Statement } from 'better-sqlite3';
import { round2 } from '../utils/money.js';

/**
 * rate_alerts 테이블 접근 계층.
 *
 * 목표 환율에 도달하면 지정한 사용자를 멘션하는 알림을 관리한다.
 */

/** 알림 발동 방향. */
export type AlertDirection = 'below' | 'above';

export interface RateAlert {
  readonly id: number;
  /** 목표 환율 (100 JPY 당 KRW). */
  readonly targetRate: number;
  /** `below` = 이 값 이하로 내려가면, `above` = 이 값 이상으로 올라가면. */
  readonly direction: AlertDirection;
  /** 멘션할 Discord 사용자 ID. */
  readonly mentionUserId: string;
  /** 알림을 만든 사용자 ID. */
  readonly createdBy: string;
  /** 알림을 보낼 채널 ID. */
  readonly channelId: string;
  /** 사용자가 붙인 메모 (예: "여행 경비 환전"). */
  readonly label: string | null;
  /** true 면 한 번 발동한 뒤 비활성화된다. */
  readonly once: boolean;
  readonly enabled: boolean;
  /** false 면 조건을 만족해도 발송하지 않는다 (재무장 대기). */
  readonly armed: boolean;
  readonly triggerCount: number;
  readonly lastTriggeredAt: string | null;
  readonly lastTriggeredRate: number | null;
  readonly createdAt: string;
}

export interface NewRateAlert {
  readonly targetRate: number;
  readonly direction: AlertDirection;
  readonly mentionUserId: string;
  readonly createdBy: string;
  readonly channelId: string;
  readonly label?: string | null;
  readonly once?: boolean;
}

interface AlertRow {
  id: number;
  target_rate: number;
  direction: string;
  mention_user_id: string;
  created_by: string;
  channel_id: string;
  label: string | null;
  once: number;
  enabled: number;
  armed: number;
  trigger_count: number;
  last_triggered_at: string | null;
  last_triggered_rate: number | null;
  created_at: string;
}

function toAlert(row: AlertRow): RateAlert {
  return {
    id: row.id,
    targetRate: row.target_rate,
    direction: row.direction === 'above' ? 'above' : 'below',
    mentionUserId: row.mention_user_id,
    createdBy: row.created_by,
    channelId: row.channel_id,
    label: row.label,
    once: row.once === 1,
    enabled: row.enabled === 1,
    armed: row.armed === 1,
    triggerCount: row.trigger_count,
    lastTriggeredAt: row.last_triggered_at,
    lastTriggeredRate: row.last_triggered_rate,
    createdAt: row.created_at,
  };
}

/** 한 사용자가 만들 수 있는 알림 수 상한 (실수로 대량 생성하는 것을 막는다). */
export const MAX_ALERTS_PER_USER = 20;

export class AlertRepository {
  readonly #insert: Statement;
  readonly #byId: Statement;
  readonly #allEnabled: Statement;
  readonly #listAll: Statement;
  readonly #listByUser: Statement;
  readonly #countByUser: Statement;
  readonly #markTriggered: Statement;
  readonly #setArmed: Statement;
  readonly #setEnabled: Statement;
  readonly #delete: Statement;
  readonly #deleteByUser: Statement;

  constructor(db: SqliteDatabase) {
    this.#insert = db.prepare(
      `INSERT INTO rate_alerts
         (target_rate, direction, mention_user_id, created_by, channel_id, label, once, created_at)
       VALUES
         (@targetRate, @direction, @mentionUserId, @createdBy, @channelId, @label, @once, @createdAt)`,
    );
    this.#byId = db.prepare(`SELECT * FROM rate_alerts WHERE id = ?`);
    this.#allEnabled = db.prepare(`SELECT * FROM rate_alerts WHERE enabled = 1 ORDER BY id ASC`);
    this.#listAll = db.prepare(`SELECT * FROM rate_alerts ORDER BY enabled DESC, id ASC`);
    this.#listByUser = db.prepare(
      `SELECT * FROM rate_alerts WHERE created_by = ? ORDER BY enabled DESC, id ASC`,
    );
    this.#countByUser = db.prepare(
      `SELECT COUNT(*) AS count FROM rate_alerts WHERE created_by = ? AND enabled = 1`,
    );
    this.#markTriggered = db.prepare(
      `UPDATE rate_alerts
          SET armed = 0,
              trigger_count = trigger_count + 1,
              last_triggered_at = @triggeredAt,
              last_triggered_rate = @rate,
              enabled = CASE WHEN once = 1 THEN 0 ELSE enabled END
        WHERE id = @id`,
    );
    this.#setArmed = db.prepare(`UPDATE rate_alerts SET armed = ? WHERE id = ?`);
    this.#setEnabled = db.prepare(`UPDATE rate_alerts SET enabled = ? WHERE id = ?`);
    this.#delete = db.prepare(`DELETE FROM rate_alerts WHERE id = ?`);
    this.#deleteByUser = db.prepare(`DELETE FROM rate_alerts WHERE id = ? AND created_by = ?`);
  }

  create(alert: NewRateAlert, createdAtIso = new Date().toISOString()): RateAlert {
    const info = this.#insert.run({
      targetRate: round2(alert.targetRate),
      direction: alert.direction,
      mentionUserId: alert.mentionUserId,
      createdBy: alert.createdBy,
      channelId: alert.channelId,
      label: alert.label ?? null,
      once: alert.once ? 1 : 0,
      createdAt: createdAtIso,
    });

    const created = this.findById(Number(info.lastInsertRowid));
    if (!created) throw new Error('알림 생성 직후 조회에 실패했습니다');
    return created;
  }

  findById(id: number): RateAlert | null {
    const row = this.#byId.get(id) as AlertRow | undefined;
    return row ? toAlert(row) : null;
  }

  /** 평가 대상 — 활성화된 알림 전체. */
  findEnabled(): RateAlert[] {
    return (this.#allEnabled.all() as AlertRow[]).map(toAlert);
  }

  findAll(): RateAlert[] {
    return (this.#listAll.all() as AlertRow[]).map(toAlert);
  }

  findByCreator(userId: string): RateAlert[] {
    return (this.#listByUser.all(userId) as AlertRow[]).map(toAlert);
  }

  countActiveByCreator(userId: string): number {
    const row = this.#countByUser.get(userId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /** 발동 기록. once 알림은 여기서 자동 비활성화된다. */
  markTriggered(id: number, rate: number, triggeredAtIso = new Date().toISOString()): void {
    this.#markTriggered.run({ id, rate: round2(rate), triggeredAt: triggeredAtIso });
  }

  /** 재무장 / 무장 해제. */
  setArmed(id: number, armed: boolean): void {
    this.#setArmed.run(armed ? 1 : 0, id);
  }

  setEnabled(id: number, enabled: boolean): void {
    this.#setEnabled.run(enabled ? 1 : 0, id);
  }

  delete(id: number): boolean {
    return this.#delete.run(id).changes > 0;
  }

  /** 만든 사람만 삭제할 수 있게 하는 변형. */
  deleteOwnedBy(id: number, userId: string): boolean {
    return this.#deleteByUser.run(id, userId).changes > 0;
  }
}
