import type { Database as SqliteDatabase, Statement } from 'better-sqlite3';
import type { NewRate, RateRecord } from '../types/exchangeRate.js';
import { round2 } from '../utils/money.js';
import { seoulDayBoundsUtc } from '../utils/time.js';

/** rates 테이블의 원시 행 형태. */
interface RateRow {
  id: number;
  rate: number;
  change_amount: number | null;
  change_percent: number | null;
  collected_at: string;
  source: string;
  created_at: string;
}

interface AggregateRow {
  high: number | null;
  low: number | null;
  count: number;
}

function toRecord(row: RateRow): RateRecord {
  return {
    id: row.id,
    rate: row.rate,
    changeAmount: row.change_amount,
    changePercent: row.change_percent,
    collectedAt: row.collected_at,
    source: row.source,
    createdAt: row.created_at,
  };
}

export interface DailyExtremes {
  readonly high: number;
  readonly low: number;
  readonly count: number;
  readonly dayKey: string;
}

/**
 * rates 테이블 접근 계층.
 *
 * 준비된 문(prepared statement)을 생성자에서 한 번만 컴파일해 재사용한다.
 * (1분마다 실행되는 경로이므로 라즈베리파이에서 의미 있는 차이가 난다.)
 */
export class RateRepository {
  readonly #db: SqliteDatabase;
  readonly #insert: Statement;
  readonly #latest: Statement;
  readonly #latestBefore: Statement;
  readonly #between: Statement;
  readonly #aggregateBetween: Statement;
  readonly #firstSince: Statement;
  readonly #deleteOlderThan: Statement;
  readonly #count: Statement;

  constructor(db: SqliteDatabase) {
    this.#db = db;

    this.#insert = db.prepare(
      `INSERT INTO rates (rate, change_amount, change_percent, collected_at, source, created_at)
       VALUES (@rate, @changeAmount, @changePercent, @collectedAt, @source, @createdAt)`,
    );

    this.#latest = db.prepare(`SELECT * FROM rates ORDER BY collected_at DESC, id DESC LIMIT 1`);

    this.#latestBefore = db.prepare(
      `SELECT * FROM rates WHERE id < ? ORDER BY collected_at DESC, id DESC LIMIT 1`,
    );

    this.#between = db.prepare(
      `SELECT * FROM rates
       WHERE collected_at >= ? AND collected_at <= ?
       ORDER BY collected_at ASC, id ASC`,
    );

    this.#aggregateBetween = db.prepare(
      `SELECT MAX(rate) AS high, MIN(rate) AS low, COUNT(*) AS count
       FROM rates
       WHERE collected_at >= ? AND collected_at <= ?`,
    );

    this.#firstSince = db.prepare(
      `SELECT * FROM rates WHERE collected_at >= ? ORDER BY collected_at ASC, id ASC LIMIT 1`,
    );

    this.#deleteOlderThan = db.prepare(`DELETE FROM rates WHERE collected_at < ?`);

    this.#count = db.prepare(`SELECT COUNT(*) AS count FROM rates`);
  }

  /** 새 환율을 저장하고 저장된 행을 반환한다. */
  insert(rate: NewRate, createdAtIso = new Date().toISOString()): RateRecord {
    const info = this.#insert.run({
      rate: round2(rate.rate),
      changeAmount: rate.changeAmount === null ? null : round2(rate.changeAmount),
      changePercent: rate.changePercent === null ? null : round2(rate.changePercent),
      collectedAt: rate.collectedAt,
      source: rate.source,
      createdAt: createdAtIso,
    });

    return {
      id: Number(info.lastInsertRowid),
      rate: round2(rate.rate),
      changeAmount: rate.changeAmount === null ? null : round2(rate.changeAmount),
      changePercent: rate.changePercent === null ? null : round2(rate.changePercent),
      collectedAt: rate.collectedAt,
      source: rate.source,
      createdAt: createdAtIso,
    };
  }

  /** 가장 최근 환율. 데이터가 없으면 null. */
  findLatest(): RateRecord | null {
    const row = this.#latest.get() as RateRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 주어진 id 직전의 환율 (전회 대비 계산용). */
  findPrevious(beforeId: number): RateRecord | null {
    const row = this.#latestBefore.get(beforeId) as RateRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** [startIso, endIso] 구간의 모든 행 (오름차순). */
  findBetween(startIso: string, endIso: string): RateRecord[] {
    const rows = this.#between.all(startIso, endIso) as RateRow[];
    return rows.map(toRecord);
  }

  /** startIso 이후 첫 번째 행 (기간 시작 환율). */
  findFirstSince(startIso: string): RateRecord | null {
    const row = this.#firstSince.get(startIso) as RateRow | undefined;
    return row ? toRecord(row) : null;
  }

  /**
   * Asia/Seoul 기준 "당일" 최고/최저.
   * 날짜가 바뀌면 경계가 자동으로 이동하므로 별도 초기화 로직이 필요 없다.
   */
  dailyExtremes(referenceIso: string = new Date().toISOString()): DailyExtremes | null {
    const { startIso, endIso, dayKey } = seoulDayBoundsUtc(referenceIso);
    const row = this.#aggregateBetween.get(startIso, endIso) as AggregateRow | undefined;
    if (!row || row.count === 0 || row.high === null || row.low === null) {
      return null;
    }
    return { high: row.high, low: row.low, count: row.count, dayKey };
  }

  /** 임의 구간의 최고/최저/개수. */
  aggregateBetween(startIso: string, endIso: string): { high: number; low: number; count: number } {
    const row = this.#aggregateBetween.get(startIso, endIso) as AggregateRow | undefined;
    if (!row || row.count === 0 || row.high === null || row.low === null) {
      return { high: Number.NaN, low: Number.NaN, count: 0 };
    }
    return { high: row.high, low: row.low, count: row.count };
  }

  /** cutoffIso 보다 오래된 행을 삭제하고 삭제 건수를 반환한다. */
  deleteOlderThan(cutoffIso: string): number {
    const info = this.#deleteOlderThan.run(cutoffIso);
    return info.changes;
  }

  /** 전체 행 수. */
  count(): number {
    const row = this.#count.get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /** 삭제 후 파일 크기를 회수한다 (보존 정책 실행 뒤 1회). */
  vacuum(): void {
    this.#db.exec('VACUUM');
  }
}
