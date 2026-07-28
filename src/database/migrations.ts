import type { Database as SqliteDatabase } from 'better-sqlite3';
import { childLogger } from '../logger.js';

const log = childLogger('migrations');

/**
 * 스키마 마이그레이션.
 *
 * `PRAGMA user_version` 을 버전 카운터로 사용한다.
 * 각 마이그레이션은 멱등(IF NOT EXISTS)하게 작성하고, 트랜잭션으로 감싼다.
 */

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: SqliteDatabase) => void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS rates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rate REAL NOT NULL,
            change_amount REAL,
            change_percent REAL,
            collected_at TEXT NOT NULL,
            source TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_rates_collected_at
            ON rates(collected_at);

        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS health_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            component TEXT NOT NULL,
            level TEXT NOT NULL,
            message TEXT NOT NULL,
            occurred_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_health_events_occurred_at
            ON health_events(occurred_at);
      `);
    },
  },
  {
    version: 2,
    name: 'rates_id_desc_index',
    up(db) {
      // 최신 N건 조회(/yen, 이전 값 비교)를 위한 내림차순 인덱스
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_rates_collected_at_desc
            ON rates(collected_at DESC, id DESC);
      `);
    },
  },
  {
    version: 3,
    name: 'rate_alerts',
    up(db) {
      // 목표 환율 도달 알림.
      //
      // `armed` 가 핵심이다. 조건을 만족해도 armed=0 이면 발송하지 않는다.
      // 발송 직후 armed=0 으로 내리고, 환율이 목표선에서 충분히 벗어나야
      // 다시 armed=1 이 된다. 이 히스테리시스가 없으면 환율이 경계선 근처에서
      // 오르내릴 때 매분 멘션이 날아간다.
      db.exec(`
        CREATE TABLE IF NOT EXISTS rate_alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target_rate REAL NOT NULL,
            direction TEXT NOT NULL CHECK (direction IN ('below', 'above')),
            mention_user_id TEXT NOT NULL,
            created_by TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            label TEXT,
            once INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            armed INTEGER NOT NULL DEFAULT 1,
            trigger_count INTEGER NOT NULL DEFAULT 0,
            last_triggered_at TEXT,
            last_triggered_rate REAL,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_rate_alerts_active
            ON rate_alerts(enabled, armed);
      `);
    },
  },
];

/** 현재 스키마 버전. */
export function currentVersion(db: SqliteDatabase): number {
  const rows = db.pragma('user_version') as Array<{ user_version: number }>;
  return rows[0]?.user_version ?? 0;
}

/** 최신 스키마 버전 (코드 기준). */
export function targetVersion(): number {
  return MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);
}

/** 미적용 마이그레이션을 순서대로 실행한다. */
export function runMigrations(db: SqliteDatabase): number {
  const from = currentVersion(db);
  const pending = MIGRATIONS.filter((migration) => migration.version > from).sort(
    (a, b) => a.version - b.version,
  );

  if (pending.length === 0) {
    log.debug({ event: 'migrations_up_to_date', version: from }, '마이그레이션 최신 상태');
    return from;
  }

  for (const migration of pending) {
    const apply = db.transaction(() => {
      migration.up(db);
      // PRAGMA 는 바인딩 파라미터를 지원하지 않으므로 숫자를 직접 삽입한다.
      // migration.version 은 코드 상수이며 외부 입력이 아니다.
      db.pragma(`user_version = ${Math.floor(migration.version)}`);
    });
    apply();
    log.info(
      { event: 'migration_applied', version: migration.version, name: migration.name },
      '마이그레이션 적용',
    );
  }

  return currentVersion(db);
}
