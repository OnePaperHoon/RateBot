import fs from 'node:fs';
import path from 'node:path';
import Database, { type Database as SqliteDatabase } from 'better-sqlite3';
import { childLogger } from '../logger.js';
import { runMigrations } from './migrations.js';

const log = childLogger('database');

export type { SqliteDatabase };

export interface OpenDatabaseOptions {
  /** DB 파일 경로. `:memory:` 도 허용 (테스트용). */
  readonly filePath: string;
  /** 마이그레이션 자동 실행 여부. 기본 true. */
  readonly migrate?: boolean;
  /** 읽기 전용으로 열기. */
  readonly readonly?: boolean;
}

/**
 * SQLite 연결을 연다.
 *
 * PRAGMA 선택 이유:
 *  - `journal_mode = WAL`: systemd 재시작/전원 차단 시 손상 위험을 줄이고
 *    읽기(슬래시 커맨드)와 쓰기(수집)가 서로 막지 않게 한다.
 *  - `synchronous = NORMAL`: WAL 과 조합 시 라즈베리파이 SD 카드 쓰기를 크게 줄이면서
 *    프로세스 크래시에 대해서는 안전하다.
 *  - `busy_timeout`: 동시 접근 시 즉시 SQLITE_BUSY 를 던지지 않고 대기한다.
 */
export function openDatabase(options: OpenDatabaseOptions): SqliteDatabase {
  const { filePath } = options;
  const isMemory = filePath === ':memory:' || filePath.startsWith('file::memory:');

  if (!isMemory) {
    const directory = path.dirname(path.resolve(filePath));
    fs.mkdirSync(directory, { recursive: true });
  }

  const db = new Database(filePath, { readonly: options.readonly ?? false });

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // WAL 파일이 무한정 커지지 않도록 상한을 둔다 (약 4MB)
  db.pragma('journal_size_limit = 4194304');

  if (options.migrate ?? true) {
    runMigrations(db);
  }

  log.debug(
    { event: 'database_opened', filePath: isMemory ? ':memory:' : filePath },
    'SQLite 연결',
  );
  return db;
}

/**
 * 연결을 안전하게 닫는다.
 * WAL 체크포인트를 수행해 재시작 후 데이터 손실/손상 가능성을 줄인다.
 */
export function closeDatabase(db: SqliteDatabase): void {
  if (!db.open) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    log.warn({ err: error }, 'WAL 체크포인트 실패 (무시하고 종료)');
  }
  db.close();
  log.debug({ event: 'database_closed' }, 'SQLite 연결 종료');
}

/** 무결성 검사. 정상이면 'ok'. */
export function checkIntegrity(db: SqliteDatabase): string {
  const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  return rows[0]?.integrity_check ?? 'unknown';
}

/** 온라인 백업. 서비스를 멈추지 않고 안전한 스냅샷을 만든다. */
export async function backupDatabase(db: SqliteDatabase, destination: string): Promise<void> {
  fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
  await db.backup(destination);
}
