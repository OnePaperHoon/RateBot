import type { Database as SqliteDatabase, Statement } from 'better-sqlite3';

/**
 * app_settings 테이블 접근 계층.
 *
 * 재시작 후에도 유지돼야 하는 "운영 상태"를 저장한다.
 * (환경변수와 달리 프로그램이 스스로 쓰는 값)
 */

export const SettingKey = {
  /** Discord 상태 메시지 ID — 매분 수정할 대상 */
  DISCORD_MESSAGE_ID: 'discord_message_id',
  /** Notion 상태 페이지 ID — 자동 탐색/생성 결과 */
  NOTION_STATUS_PAGE_ID: 'notion_status_page_id',
  /** Notion 이력 행을 마지막으로 추가한 시각 (ISO) */
  LAST_NOTION_HISTORY_AT: 'last_notion_history_at',
  /** 마지막 보존 정책 실행 시각 (ISO) */
  LAST_RETENTION_AT: 'last_retention_at',
  /** 연속 실패 경고를 이미 보냈는지 (`'1'` / `'0'`) */
  FAILURE_ALERT_SENT: 'failure_alert_sent',
} as const;

export type SettingKeyName = (typeof SettingKey)[keyof typeof SettingKey];

interface SettingRow {
  key: string;
  value: string;
  updated_at: string;
}

export class SettingsRepository {
  readonly #get: Statement;
  readonly #set: Statement;
  readonly #delete: Statement;
  readonly #all: Statement;

  constructor(db: SqliteDatabase) {
    this.#get = db.prepare(`SELECT * FROM app_settings WHERE key = ?`);
    this.#set = db.prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (@key, @value, @updatedAt)
       ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @updatedAt`,
    );
    this.#delete = db.prepare(`DELETE FROM app_settings WHERE key = ?`);
    this.#all = db.prepare(`SELECT * FROM app_settings ORDER BY key ASC`);
  }

  /** 값이 없으면 null. */
  get(key: string): string | null {
    const row = this.#get.get(key) as SettingRow | undefined;
    return row?.value ?? null;
  }

  /** 값과 갱신 시각을 함께 조회. */
  getWithMeta(key: string): { value: string; updatedAt: string } | null {
    const row = this.#get.get(key) as SettingRow | undefined;
    return row ? { value: row.value, updatedAt: row.updated_at } : null;
  }

  set(key: string, value: string, updatedAtIso = new Date().toISOString()): void {
    this.#set.run({ key, value, updatedAt: updatedAtIso });
  }

  delete(key: string): void {
    this.#delete.run(key);
  }

  /** 불리언 편의 접근자. */
  getBoolean(key: string, defaultValue = false): boolean {
    const value = this.get(key);
    if (value === null) return defaultValue;
    return value === '1' || value.toLowerCase() === 'true';
  }

  setBoolean(key: string, value: boolean): void {
    this.set(key, value ? '1' : '0');
  }

  /** 전체 설정 (CLI 진단용). */
  all(): Array<{ key: string; value: string; updatedAt: string }> {
    const rows = this.#all.all() as SettingRow[];
    return rows.map((row) => ({ key: row.key, value: row.value, updatedAt: row.updated_at }));
  }
}
