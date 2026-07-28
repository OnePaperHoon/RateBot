import type { Client, QueryDataSourceParameters } from '@notionhq/client';
import { childLogger, LogEvent } from '../logger.js';
import { SettingKey, type SettingsRepository } from '../database/settingsRepository.js';
import type { RateSnapshot } from '../types/exchangeRate.js';
import { describeNotionError, isObjectNotFound } from './client.js';
import { buildStatusProperties, toCreateProperties, toUpdateProperties } from './properties.js';

const log = childLogger('notion-status');

/** 상태 행을 식별하는 Title 값. */
export const STATUS_ROW_TITLE = 'YenWatch';

export interface NotionStatusRepositoryDeps {
  readonly client: Client;
  readonly dataSourceId: string;
  readonly settings: SettingsRepository;
  /** `.env` 의 NOTION_STATUS_PAGE_ID (비어 있으면 자동 탐색). */
  readonly configuredPageId?: string;
}

/**
 * Notion 상태 데이터베이스 리포지토리.
 *
 * 페이지 결정 순서 (요구사항 4.1):
 *   1. `NOTION_STATUS_PAGE_ID` 환경변수
 *   2. SQLite 에 저장된 페이지 ID
 *   3. 데이터 소스에서 `Name = YenWatch` 인 페이지 검색
 *   4. 없으면 새로 생성 -> ID 를 SQLite 에 저장
 *
 * 이후 매분 같은 페이지를 갱신한다. 페이지가 삭제되면 다시 생성한다.
 */
export class NotionStatusRepository {
  readonly #client: Client;
  readonly #dataSourceId: string;
  readonly #settings: SettingsRepository;
  readonly #configuredPageId: string;

  #cachedPageId: string | null = null;

  constructor(deps: NotionStatusRepositoryDeps) {
    this.#client = deps.client;
    this.#dataSourceId = deps.dataSourceId;
    this.#settings = deps.settings;
    this.#configuredPageId = (deps.configuredPageId ?? '').trim();
  }

  /** 현재 사용 중인 상태 페이지 ID (아직 해결되지 않았으면 null). */
  get pageId(): string | null {
    return this.#cachedPageId;
  }

  /**
   * 상태 페이지를 갱신한다. 없으면 만든다.
   * 실패해도 예외를 던지지만, 호출부(notificationService)가 잡아서 격리한다.
   */
  async upsert(snapshot: RateSnapshot, options: { healthy: boolean }): Promise<string> {
    const properties = buildStatusProperties(snapshot, { healthy: options.healthy });
    const pageId = await this.#resolvePageId();

    if (pageId !== null) {
      try {
        await this.#client.pages.update({
          page_id: pageId,
          properties: toUpdateProperties(properties),
        });
        log.debug(
          { event: LogEvent.NOTION_PAGE_UPDATED, rate: snapshot.rate, healthy: options.healthy },
          'Notion 상태 페이지 갱신',
        );
        return pageId;
      } catch (error) {
        if (!isObjectNotFound(error)) throw error;
        // 사용자가 페이지를 삭제한 경우 — 캐시를 비우고 새로 만든다.
        log.warn(
          { event: 'notion_page_missing', reason: describeNotionError(error) },
          'Notion 상태 페이지가 사라졌습니다 — 새로 생성합니다',
        );
        this.#forgetPageId();
      }
    }

    return this.#createPage(properties);
  }

  async #createPage(properties: ReturnType<typeof buildStatusProperties>): Promise<string> {
    const created = await this.#client.pages.create({
      parent: { type: 'data_source_id', data_source_id: this.#dataSourceId },
      properties: toCreateProperties(properties),
    });

    this.#cachedPageId = created.id;
    this.#settings.set(SettingKey.NOTION_STATUS_PAGE_ID, created.id);
    log.info(
      { event: LogEvent.NOTION_PAGE_CREATED, pageId: created.id },
      'Notion 상태 페이지 생성',
    );
    return created.id;
  }

  /** 우선순위에 따라 페이지 ID 를 결정한다. */
  async #resolvePageId(): Promise<string | null> {
    if (this.#cachedPageId !== null) return this.#cachedPageId;

    // 1. 환경변수
    if (this.#configuredPageId !== '') {
      this.#cachedPageId = this.#configuredPageId;
      return this.#cachedPageId;
    }

    // 2. SQLite 에 저장된 값
    const stored = this.#settings.get(SettingKey.NOTION_STATUS_PAGE_ID);
    if (stored !== null && stored.trim() !== '') {
      this.#cachedPageId = stored.trim();
      return this.#cachedPageId;
    }

    // 3. 데이터 소스 검색
    const found = await this.#findByTitle(STATUS_ROW_TITLE);
    if (found !== null) {
      this.#cachedPageId = found;
      this.#settings.set(SettingKey.NOTION_STATUS_PAGE_ID, found);
      log.info(
        { event: 'notion_page_found', pageId: found },
        '기존 Notion 상태 페이지를 찾았습니다',
      );
      return found;
    }

    // 4. 없음 -> 호출부가 생성
    return null;
  }

  /** `Name` 이 정확히 일치하는 페이지를 찾는다. */
  async #findByTitle(title: string): Promise<string | null> {
    const filter = {
      property: 'Name',
      title: { equals: title },
    } as unknown as QueryDataSourceParameters['filter'];

    const response = await this.#client.dataSources.query({
      data_source_id: this.#dataSourceId,
      filter,
      page_size: 1,
    });

    const first = response.results[0];
    return first ? first.id : null;
  }

  #forgetPageId(): void {
    this.#cachedPageId = null;
    if (this.#configuredPageId === '') {
      this.#settings.delete(SettingKey.NOTION_STATUS_PAGE_ID);
    }
  }
}
