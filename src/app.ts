import { Events, type Client } from 'discord.js';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { Client as NotionClient } from '@notionhq/client';

import type { Env } from './config/env.js';
import { NotionSchemaError, toError } from './errors.js';
import { childLogger, LogEvent } from './logger.js';
import { APP_VERSION } from './version.js';

import { AlertRepository } from './database/alertRepository.js';
import { closeDatabase, openDatabase } from './database/client.js';
import { HealthRepository } from './database/healthRepository.js';
import { RateRepository } from './database/rateRepository.js';
import { SettingsRepository } from './database/settingsRepository.js';

import { NaverJpyScraper } from './scraper/naverJpyScraper.js';

import { createDiscordClient, destroyClient, loginAndWaitReady } from './discord/client.js';
import {
  handleAlertRemoveMenu,
  handleInteraction,
  ALERT_REMOVE_MENU_ID,
  type CommandDeps,
} from './discord/commands.js';
import { buildStatusEmbed } from './discord/embeds.js';
import { StatusMessageManager } from './discord/statusMessage.js';

import {
  createNotionClient,
  checkConnection,
  fetchAndValidateDataSource,
} from './notion/client.js';
import { NotionHistoryRepository } from './notion/historyRepository.js';
import { NotionStatusRepository } from './notion/statusRepository.js';
import { HISTORY_PROPERTIES, STATUS_PROPERTIES } from './notion/schema.js';

import { AlertService } from './services/alertService.js';
import { ExchangeRateService } from './services/exchangeRateService.js';
import { HealthService } from './services/healthService.js';
import { NotificationService } from './services/notificationService.js';
import { RetentionService } from './services/retentionService.js';
import { SchedulerService } from './services/schedulerService.js';

import type { CollectionOutcome, CollectionTrigger } from './types/exchangeRate.js';

const log = childLogger('app');

/** 종료 시 진행 중인 수집을 기다릴 최대 시간. systemd TimeoutStopSec=30 보다 짧게 잡는다. */
const SHUTDOWN_COLLECTION_TIMEOUT_MS = 20_000;

/**
 * YenWatch 애플리케이션.
 *
 * 모든 의존성을 이 클래스에서 조립하고, 종료 시 역순으로 정리한다.
 * 각 계층은 서로를 직접 import 하지 않고 생성자 주입으로 연결된다.
 */
export class YenWatchApp {
  readonly #env: Env;

  #db: SqliteDatabase | null = null;
  #discord: Client | null = null;

  #rateService: ExchangeRateService | null = null;
  #alertService: AlertService | null = null;
  #healthService: HealthService | null = null;
  #notifications: NotificationService | null = null;
  #scheduler: SchedulerService | null = null;
  #retention: RetentionService | null = null;

  #shuttingDown = false;

  constructor(env: Env) {
    this.#env = env;
  }

  /** 애플리케이션 기동. 실패하면 예외를 던진다. */
  async start(): Promise<void> {
    const env = this.#env;

    log.info(
      {
        event: LogEvent.APP_STARTED,
        version: APP_VERSION,
        nodeEnv: env.NODE_ENV,
        intervalSeconds: env.SCRAPE_INTERVAL_SECONDS,
        notionEnabled: env.NOTION_ENABLED,
        notionHistoryEnabled: env.NOTION_HISTORY_ENABLED,
        sqlitePath: env.SQLITE_PATH,
      },
      'YenWatch 시작',
    );

    // ---------- 1. SQLite ----------
    const db = openDatabase({ filePath: env.SQLITE_PATH });
    this.#db = db;

    const rates = new RateRepository(db);
    const settings = new SettingsRepository(db);
    const healthRepo = new HealthRepository(db);
    const alertRepo = new AlertRepository(db);

    // ---------- 2. 도메인 서비스 ----------
    const scraper = new NaverJpyScraper({
      url: env.NAVER_JPY_URL,
      apiUrl: env.NAVER_JPY_API_URL,
      timeoutMs: env.REQUEST_TIMEOUT_MS,
      minValid: env.MIN_VALID_JPY100_KRW,
      maxValid: env.MAX_VALID_JPY100_KRW,
    });

    const rateService = new ExchangeRateService({ scraper, rates, health: healthRepo });
    this.#rateService = rateService;

    const healthService = new HealthService({
      settings,
      health: healthRepo,
      failureAlertThreshold: env.FAILURE_ALERT_THRESHOLD,
    });
    healthService.hydrateFromLastRecord(rates.findLatest()?.collectedAt ?? null);
    this.#healthService = healthService;

    this.#alertService = new AlertService({
      alerts: alertRepo,
      health: healthRepo,
      rearmMarginKrw: env.ALERT_REARM_MARGIN_KRW,
    });

    // ---------- 3. Discord ----------
    const discord = createDiscordClient();
    this.#discord = discord;
    await loginAndWaitReady(discord, { token: env.DISCORD_TOKEN });

    const statusMessage = new StatusMessageManager({
      client: discord,
      channelId: env.DISCORD_CHANNEL_ID,
      settings,
    });

    // ---------- 4. Notion (선택) ----------
    const notionParts = env.NOTION_ENABLED
      ? await this.#setupNotion(settings, healthRepo)
      : { status: null, history: null };

    // ---------- 5. 알림 / 보존 / 스케줄러 ----------
    const notifications = new NotificationService({
      statusMessage,
      notionStatus: notionParts.status,
      notionHistory: notionParts.history,
      healthService,
      healthRepo,
      config: {
        staleAfterMinutes: env.STALE_AFTER_MINUTES,
        scrapeIntervalSeconds: env.SCRAPE_INTERVAL_SECONDS,
        failureAlertThreshold: env.FAILURE_ALERT_THRESHOLD,
      },
    });
    this.#notifications = notifications;

    const retention = new RetentionService({
      rates,
      health: healthRepo,
      settings,
      retentionDays: env.DATA_RETENTION_DAYS,
    });
    this.#retention = retention;

    const scheduler = new SchedulerService({
      onTick: async () => {
        await this.#runCollectionCycle('schedule');
      },
      intervalSeconds: env.SCRAPE_INTERVAL_SECONDS,
      retention,
    });
    this.#scheduler = scheduler;

    // ---------- 6. 슬래시 커맨드 라우팅 ----------
    const commandDeps: CommandDeps = {
      rateService,
      healthService,
      alertRepository: alertRepo,
      runCollection: (trigger) => this.#runCollectionCycle(trigger),
      config: {
        staleAfterMinutes: env.STALE_AFTER_MINUTES,
        scrapeIntervalSeconds: env.SCRAPE_INTERVAL_SECONDS,
        allowedUserIds: env.DISCORD_ALLOWED_USER_IDS,
        sqlitePath: env.SQLITE_PATH,
        notionEnabled: env.NOTION_ENABLED,
        minValidRate: env.MIN_VALID_JPY100_KRW,
        maxValidRate: env.MAX_VALID_JPY100_KRW,
      },
      status: {
        notionConnected: () => notifications.notionConnected(),
        sqliteHealthy: () => this.#isSqliteHealthy(),
        nextCollectionAt: () => scheduler.nextRunAt(),
      },
      statusBoard: {
        // 정기 갱신과 같은 Embed 를 써야 재생성 직후 모습이 달라지지 않는다.
        repost: async () => {
          const health = healthService.snapshot();
          const embed = buildStatusEmbed(rateService.getLastKnownSnapshot(), {
            staleAfterMinutes: env.STALE_AFTER_MINUTES,
            scrapeIntervalSeconds: env.SCRAPE_INTERVAL_SECONDS,
            lastFailureAt: health.lastFailureAt,
            lastFailureReason: health.lastFailureReason,
            consecutiveFailures: health.consecutiveFailures,
          });
          const message = await statusMessage.repost(embed);
          return { messageId: message.id, channelId: message.channelId };
        },
      },
    };

    discord.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand()) {
        void handleInteraction(interaction, commandDeps);
        return;
      }
      // `/yen-alert list` 의 삭제 드롭다운
      if (
        interaction.isStringSelectMenu() &&
        interaction.customId.startsWith(ALERT_REMOVE_MENU_ID)
      ) {
        void handleAlertRemoveMenu(interaction, commandDeps).catch((error: unknown) => {
          log.error({ event: 'alert_menu_failed', err: error }, '알림 삭제 드롭다운 처리 실패');
        });
      }
    });

    discord.on(Events.Error, (error) => {
      log.error({ event: 'discord_client_error', err: error }, 'Discord 클라이언트 오류');
      healthRepo.record('discord', 'error', `클라이언트 오류: ${error.message}`);
    });

    // ---------- 7. 최초 수집 즉시 실행 ----------
    await this.#runCollectionCycle('startup');

    // ---------- 8. 주기 스케줄 시작 ----------
    scheduler.start();

    log.info(
      { event: 'app_ready', nextRunAt: scheduler.nextRunAt() },
      'YenWatch 준비 완료 — 주기 수집을 시작합니다',
    );
  }

  /**
   * 수집 -> 상태 기록 -> 외부 서비스 갱신 -> 알림 판단까지의 한 사이클.
   * 정기 스케줄과 `/yen-refresh` 가 이 함수를 공유하므로 lock 도 공유된다.
   */
  async #runCollectionCycle(trigger: CollectionTrigger): Promise<CollectionOutcome> {
    const rateService = this.#rateService;
    const healthService = this.#healthService;
    const notifications = this.#notifications;

    if (!rateService || !healthService || !notifications) {
      return { status: 'skipped', reason: '애플리케이션이 아직 초기화되지 않았습니다' };
    }

    const outcome = await rateService.collect(trigger);

    if (outcome.status === 'skipped') {
      return outcome;
    }

    if (outcome.status === 'success') {
      const action = healthService.recordSuccess(outcome.snapshot);
      await notifications.publish(outcome.snapshot, true);
      if (action === 'send-recovery') {
        await notifications.sendRecovery(outcome.snapshot);
      }

      // 목표 환율 알림 — 상태 메시지 갱신과 독립적으로 처리한다.
      // 평가는 DB 만 건드리므로 실패해도 수집 결과에 영향이 없다.
      const alertService = this.#alertService;
      if (alertService) {
        const triggers = alertService.evaluate(outcome.snapshot);
        if (triggers.length > 0) {
          await notifications.sendAlerts(triggers);
        }
      }

      return outcome;
    }

    // 실패: 마지막 정상 데이터를 유지한 채 경고 표시, Notion 상태는 '오류'
    const action = healthService.recordFailure(outcome.error);
    const lastKnown = rateService.getLastKnownSnapshot();
    await notifications.publish(lastKnown, false);
    if (action === 'send-failure-alert') {
      await notifications.sendFailureAlert(outcome.error.message);
    }
    return outcome;
  }

  /** Notion 초기화. 스키마 오류는 치명적으로 다루지 않고 Notion 만 비활성화한다. */
  async #setupNotion(
    settings: SettingsRepository,
    healthRepo: HealthRepository,
  ): Promise<{ status: NotionStatusRepository | null; history: NotionHistoryRepository | null }> {
    const env = this.#env;
    const client: NotionClient = createNotionClient({ token: env.NOTION_TOKEN });

    const connection = await checkConnection(client);
    if (!connection.ok) {
      log.error(
        { event: 'notion_connection_failed', reason: connection.error },
        'Notion 연결 실패 — Notion 기능 없이 계속 실행합니다',
      );
      healthRepo.record('notion', 'error', `연결 실패: ${connection.error ?? '알 수 없음'}`);
      return { status: null, history: null };
    }

    let statusRepo: NotionStatusRepository | null = null;
    try {
      await fetchAndValidateDataSource(
        client,
        env.NOTION_DATA_SOURCE_ID,
        STATUS_PROPERTIES,
        '상태 데이터베이스',
      );
      statusRepo = new NotionStatusRepository({
        client,
        dataSourceId: env.NOTION_DATA_SOURCE_ID,
        settings,
        configuredPageId: env.NOTION_STATUS_PAGE_ID,
      });
    } catch (caught) {
      this.#reportNotionSetupFailure(caught, healthRepo, '상태 데이터베이스');
      return { status: null, history: null };
    }

    let historyRepo: NotionHistoryRepository | null = null;
    if (env.NOTION_HISTORY_ENABLED) {
      try {
        await fetchAndValidateDataSource(
          client,
          env.NOTION_HISTORY_DATA_SOURCE_ID,
          HISTORY_PROPERTIES,
          '이력 데이터베이스',
        );
        historyRepo = new NotionHistoryRepository({
          client,
          dataSourceId: env.NOTION_HISTORY_DATA_SOURCE_ID,
          settings,
          intervalMinutes: env.NOTION_HISTORY_INTERVAL_MINUTES,
        });
      } catch (caught) {
        // 이력 실패는 상태 갱신을 막지 않는다.
        this.#reportNotionSetupFailure(caught, healthRepo, '이력 데이터베이스');
      }
    }

    return { status: statusRepo, history: historyRepo };
  }

  #reportNotionSetupFailure(caught: unknown, healthRepo: HealthRepository, label: string): void {
    if (caught instanceof NotionSchemaError) {
      // 사람이 그대로 보고 고칠 수 있도록 리포트를 통째로 출력한다.
      log.error({ event: 'notion_schema_invalid', label }, `\n${caught.report}`);
      healthRepo.record('notion', 'error', `${label} 스키마 오류: ${caught.message}`);
      return;
    }
    const error = toError(caught);
    log.error(
      { event: 'notion_setup_failed', label, reason: error.message },
      `${label} 초기화 실패 — 해당 기능 없이 계속 실행합니다`,
    );
    healthRepo.record('notion', 'error', `${label} 초기화 실패: ${error.message}`);
  }

  #isSqliteHealthy(): boolean {
    const db = this.#db;
    if (!db || !db.open) return false;
    try {
      db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 정상 종료 (요구사항 14).
   *
   *   1. 새로운 스케줄 작업 중지
   *   2. 진행 중인 수집이 끝날 때까지 제한 시간 내 대기
   *   3. Discord 클라이언트 종료
   *   4. SQLite 연결 종료 (WAL 체크포인트 포함)
   *   5. 로그 flush
   */
  async shutdown(reason: string): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;

    log.info({ event: LogEvent.SHUTDOWN_STARTED, reason }, '종료 절차 시작');

    // 1. 새 작업 예약 중지
    this.#scheduler?.stop();

    // 2. 진행 중인 수집 대기
    if (this.#rateService) {
      const finished = await this.#rateService.waitForIdle(SHUTDOWN_COLLECTION_TIMEOUT_MS);
      if (!finished) {
        log.warn(
          { event: 'shutdown_collection_timeout', timeoutMs: SHUTDOWN_COLLECTION_TIMEOUT_MS },
          '진행 중인 수집이 제한 시간 안에 끝나지 않았습니다 — 그대로 종료합니다',
        );
      }
    }

    // 3. Discord 종료
    if (this.#discord) {
      await destroyClient(this.#discord);
      this.#discord = null;
    }

    // Notion SDK 는 fetch 기반이라 명시적 종료가 필요 없다.

    // 4. SQLite 종료
    if (this.#db) {
      try {
        closeDatabase(this.#db);
      } catch (error) {
        log.error({ err: error }, 'SQLite 종료 중 오류');
      }
      this.#db = null;
    }

    log.info({ event: LogEvent.SHUTDOWN_COMPLETED, reason }, '종료 완료');
  }

  /** 테스트/CLI 에서 참조하기 위한 접근자. */
  get scheduler(): SchedulerService | null {
    return this.#scheduler;
  }

  get retention(): RetentionService | null {
    return this.#retention;
  }
}
