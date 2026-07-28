import type { Client } from '@notionhq/client';
import { childLogger } from '../logger.js';
import { SettingKey, type SettingsRepository } from '../database/settingsRepository.js';
import type { RateSnapshot } from '../types/exchangeRate.js';
import { formatSeoul } from '../utils/time.js';
import { buildHistoryProperties, toCreateProperties } from './properties.js';

const log = childLogger('notion-history');

export interface NotionHistoryRepositoryDeps {
  readonly client: Client;
  readonly dataSourceId: string;
  readonly settings: SettingsRepository;
  /** 이력 행 생성 최소 간격(분). */
  readonly intervalMinutes: number;
}

/**
 * Notion 이력 데이터베이스 리포지토리 (선택 기능).
 *
 * 요구사항 4.2:
 *  - SQLite 에는 매분 저장하지만 Notion 이력은 과도한 행 증가를 막기 위해
 *    `NOTION_HISTORY_INTERVAL_MINUTES` (기본 60분) 주기로만 추가한다.
 *  - 마지막 추가 시각은 app_settings 에 저장해 재시작 후에도 주기가 유지된다.
 */
export class NotionHistoryRepository {
  readonly #client: Client;
  readonly #dataSourceId: string;
  readonly #settings: SettingsRepository;
  readonly #intervalMs: number;

  constructor(deps: NotionHistoryRepositoryDeps) {
    this.#client = deps.client;
    this.#dataSourceId = deps.dataSourceId;
    this.#settings = deps.settings;
    this.#intervalMs = Math.max(1, deps.intervalMinutes) * 60_000;
  }

  /** 다음 이력 행을 추가해도 되는 시점인가. */
  shouldAppend(now: Date = new Date()): boolean {
    const last = this.#settings.get(SettingKey.LAST_NOTION_HISTORY_AT);
    if (last === null) return true;

    const lastMs = new Date(last).getTime();
    if (Number.isNaN(lastMs)) return true;

    return now.getTime() - lastMs >= this.#intervalMs;
  }

  /** 다음 이력 행 추가까지 남은 밀리초 (0 이면 지금 가능). */
  msUntilNext(now: Date = new Date()): number {
    const last = this.#settings.get(SettingKey.LAST_NOTION_HISTORY_AT);
    if (last === null) return 0;
    const lastMs = new Date(last).getTime();
    if (Number.isNaN(lastMs)) return 0;
    return Math.max(0, this.#intervalMs - (now.getTime() - lastMs));
  }

  /**
   * 주기가 됐으면 이력 행을 추가한다.
   * @returns 실제로 추가했으면 페이지 ID, 주기가 아니면 null.
   */
  async appendIfDue(snapshot: RateSnapshot, now: Date = new Date()): Promise<string | null> {
    if (!this.shouldAppend(now)) return null;
    return this.append(snapshot, now);
  }

  /** 주기와 무관하게 이력 행을 추가한다. */
  async append(snapshot: RateSnapshot, now: Date = new Date()): Promise<string> {
    const title = formatSeoul(snapshot.collectedAt, 'yyyy-MM-dd HH:mm');
    const properties = buildHistoryProperties(snapshot, title);

    const created = await this.#client.pages.create({
      parent: { type: 'data_source_id', data_source_id: this.#dataSourceId },
      properties: toCreateProperties(properties),
    });

    this.#settings.set(SettingKey.LAST_NOTION_HISTORY_AT, now.toISOString());
    log.info(
      { event: 'notion_history_appended', pageId: created.id, rate: snapshot.rate },
      'Notion 이력 행 추가',
    );
    return created.id;
  }
}
