import type { Database as SqliteDatabase, Statement } from 'better-sqlite3';
import type { HealthComponent, HealthLevel } from '../types/exchangeRate.js';

/**
 * health_events 테이블 접근 계층.
 *
 * 운영 중 발생한 사건(수집 실패, Discord 재생성, Notion 스키마 오류 등)을
 * 영구 기록해 `/yen-status` 와 `npm run cli` 진단에서 되짚어볼 수 있게 한다.
 *
 * 주의: 메시지에 토큰이나 전체 HTML 을 넣지 않는다.
 */

export interface HealthEvent {
  readonly id: number;
  readonly component: HealthComponent;
  readonly level: HealthLevel;
  readonly message: string;
  readonly occurredAt: string;
}

interface HealthEventRow {
  id: number;
  component: string;
  level: string;
  message: string;
  occurred_at: string;
}

/** 메시지 길이 상한 — DB 비대화 방지 */
const MAX_MESSAGE_LENGTH = 500;

function toEvent(row: HealthEventRow): HealthEvent {
  return {
    id: row.id,
    component: row.component as HealthComponent,
    level: row.level as HealthLevel,
    message: row.message,
    occurredAt: row.occurred_at,
  };
}

export class HealthRepository {
  readonly #insert: Statement;
  readonly #recent: Statement;
  readonly #recentByLevel: Statement;
  readonly #latestByComponentLevel: Statement;
  readonly #deleteOlderThan: Statement;
  readonly #count: Statement;

  constructor(db: SqliteDatabase) {
    this.#insert = db.prepare(
      `INSERT INTO health_events (component, level, message, occurred_at)
       VALUES (@component, @level, @message, @occurredAt)`,
    );
    this.#recent = db.prepare(
      `SELECT * FROM health_events ORDER BY occurred_at DESC, id DESC LIMIT ?`,
    );
    this.#recentByLevel = db.prepare(
      `SELECT * FROM health_events WHERE level = ? ORDER BY occurred_at DESC, id DESC LIMIT ?`,
    );
    this.#latestByComponentLevel = db.prepare(
      `SELECT * FROM health_events
       WHERE component = ? AND level = ?
       ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    );
    this.#deleteOlderThan = db.prepare(`DELETE FROM health_events WHERE occurred_at < ?`);
    this.#count = db.prepare(`SELECT COUNT(*) AS count FROM health_events`);
  }

  record(
    component: HealthComponent,
    level: HealthLevel,
    message: string,
    occurredAtIso = new Date().toISOString(),
  ): void {
    this.#insert.run({
      component,
      level,
      message: message.slice(0, MAX_MESSAGE_LENGTH),
      occurredAt: occurredAtIso,
    });
  }

  recent(limit = 20): HealthEvent[] {
    const rows = this.#recent.all(limit) as HealthEventRow[];
    return rows.map(toEvent);
  }

  recentByLevel(level: HealthLevel, limit = 20): HealthEvent[] {
    const rows = this.#recentByLevel.all(level, limit) as HealthEventRow[];
    return rows.map(toEvent);
  }

  latest(component: HealthComponent, level: HealthLevel): HealthEvent | null {
    const row = this.#latestByComponentLevel.get(component, level) as HealthEventRow | undefined;
    return row ? toEvent(row) : null;
  }

  deleteOlderThan(cutoffIso: string): number {
    return this.#deleteOlderThan.run(cutoffIso).changes;
  }

  count(): number {
    const row = this.#count.get() as { count: number } | undefined;
    return row?.count ?? 0;
  }
}
