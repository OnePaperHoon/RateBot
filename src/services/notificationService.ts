import { childLogger } from '../logger.js';
import { toError } from '../errors.js';
import type { StatusMessageManager } from '../discord/statusMessage.js';
import {
  buildAlertEmbed,
  buildFailureAlertEmbed,
  buildRecoveryEmbed,
  buildStatusEmbed,
} from '../discord/embeds.js';
import type { AlertTrigger } from './alertService.js';
import type { NotionHistoryRepository } from '../notion/historyRepository.js';
import type { NotionStatusRepository } from '../notion/statusRepository.js';
import { describeNotionError } from '../notion/client.js';
import type { HealthRepository } from '../database/healthRepository.js';
import type { RateSnapshot } from '../types/exchangeRate.js';
import type { HealthService } from './healthService.js';

const log = childLogger('notification');

export interface NotificationConfig {
  readonly staleAfterMinutes: number;
  readonly scrapeIntervalSeconds: number;
  readonly failureAlertThreshold: number;
}

export interface NotificationServiceDeps {
  readonly statusMessage: StatusMessageManager | null;
  readonly notionStatus: NotionStatusRepository | null;
  readonly notionHistory: NotionHistoryRepository | null;
  readonly healthService: HealthService;
  readonly healthRepo: HealthRepository;
  readonly config: NotificationConfig;
}

/** 각 채널의 마지막 전송 결과. `/yen-status` 표시에 사용. */
export interface ChannelStatus {
  readonly discordOk: boolean | null;
  readonly notionOk: boolean | null;
}

/**
 * 외부 서비스(Discord / Notion) 갱신 오케스트레이션.
 *
 * 핵심 원칙 (요구사항 20):
 *  - Discord 실패가 Notion 갱신을 막지 않는다.
 *  - Notion 실패가 Discord 갱신을 막지 않는다.
 *  - 둘 다 실패해도 수집 루프는 계속 돈다 (예외를 밖으로 던지지 않는다).
 */
export class NotificationService {
  readonly #statusMessage: StatusMessageManager | null;
  readonly #notionStatus: NotionStatusRepository | null;
  readonly #notionHistory: NotionHistoryRepository | null;
  readonly #health: HealthService;
  readonly #healthRepo: HealthRepository;
  readonly #config: NotificationConfig;

  #discordOk: boolean | null = null;
  #notionOk: boolean | null = null;

  constructor(deps: NotificationServiceDeps) {
    this.#statusMessage = deps.statusMessage;
    this.#notionStatus = deps.notionStatus;
    this.#notionHistory = deps.notionHistory;
    this.#health = deps.healthService;
    this.#healthRepo = deps.healthRepo;
    this.#config = deps.config;
  }

  get channelStatus(): ChannelStatus {
    return { discordOk: this.#discordOk, notionOk: this.#notionOk };
  }

  /** Notion 사용 여부 및 마지막 통신 성공 여부. */
  notionConnected(): boolean | null {
    return this.#notionStatus === null ? null : this.#notionOk;
  }

  /**
   * 수집 결과를 Discord 상태 메시지와 Notion 상태 페이지에 반영한다.
   *
   * @param snapshot 표시할 데이터. 수집 실패 시에는 마지막 정상 데이터를 넘긴다.
   * @param healthy  이번 수집이 성공했는가 (Notion Status 속성 값 결정)
   */
  async publish(snapshot: RateSnapshot | null, healthy: boolean): Promise<void> {
    // 두 채널을 병렬로, 서로 독립적으로 실행한다.
    await Promise.allSettled([
      this.#updateDiscord(snapshot),
      this.#updateNotion(snapshot, healthy),
    ]);
  }

  async #updateDiscord(snapshot: RateSnapshot | null): Promise<void> {
    if (this.#statusMessage === null) return;

    const health = this.#health.snapshot();
    const embed = buildStatusEmbed(snapshot, {
      staleAfterMinutes: this.#config.staleAfterMinutes,
      scrapeIntervalSeconds: this.#config.scrapeIntervalSeconds,
      lastFailureAt: health.lastFailureAt,
      lastFailureReason: health.lastFailureReason,
      consecutiveFailures: health.consecutiveFailures,
    });

    try {
      await this.#statusMessage.update(embed);
      this.#discordOk = true;
    } catch (caught) {
      const error = toError(caught);
      this.#discordOk = false;
      log.error(
        { event: 'discord_update_failed', reason: error.message, errorType: error.name },
        'Discord 상태 메시지 갱신 실패 (수집은 계속됩니다)',
      );
      this.#healthRepo.record('discord', 'error', `상태 메시지 갱신 실패: ${error.message}`);
    }
  }

  async #updateNotion(snapshot: RateSnapshot | null, healthy: boolean): Promise<void> {
    if (this.#notionStatus === null || snapshot === null) return;

    try {
      await this.#notionStatus.upsert(snapshot, { healthy });
      this.#notionOk = true;
    } catch (caught) {
      this.#notionOk = false;
      const reason = describeNotionError(caught);
      log.error(
        { event: 'notion_update_failed', reason },
        'Notion 상태 페이지 갱신 실패 (수집은 계속됩니다)',
      );
      this.#healthRepo.record('notion', 'error', `상태 페이지 갱신 실패: ${reason}`);
      return;
    }

    // 이력은 성공한 수집에 대해서만, 그리고 설정된 주기에만 기록한다.
    if (!healthy || this.#notionHistory === null) return;

    try {
      await this.#notionHistory.appendIfDue(snapshot);
    } catch (caught) {
      const reason = describeNotionError(caught);
      log.error(
        { event: 'notion_history_failed', reason },
        'Notion 이력 추가 실패 (무시하고 계속)',
      );
      this.#healthRepo.record('notion', 'warn', `이력 추가 실패: ${reason}`);
    }
  }

  /** 연속 실패 경고를 채널에 1회 발송한다. */
  async sendFailureAlert(reason: string): Promise<void> {
    if (this.#statusMessage === null) return;

    const health = this.#health.snapshot();
    const embed = buildFailureAlertEmbed({
      consecutiveFailures: health.consecutiveFailures,
      threshold: this.#config.failureAlertThreshold,
      reason,
      lastSuccessAt: health.lastSuccessAt,
    });

    try {
      await this.#statusMessage.sendNotice(embed);
      log.warn({ event: 'failure_alert_sent' }, '연속 실패 경고 발송');
    } catch (caught) {
      const error = toError(caught);
      log.error({ event: 'failure_alert_failed', reason: error.message }, '경고 발송 실패');
      this.#healthRepo.record('discord', 'error', `경고 발송 실패: ${error.message}`);
    }
  }

  /**
   * 목표 환율 알림을 발송한다 — 지정된 사용자를 실제로 멘션한다.
   *
   * 알림 하나가 실패해도 나머지는 계속 보낸다.
   */
  async sendAlerts(triggers: readonly AlertTrigger[]): Promise<void> {
    if (this.#statusMessage === null || triggers.length === 0) return;

    for (const trigger of triggers) {
      const { alert, snapshot } = trigger;
      try {
        await this.#statusMessage.sendMention(
          `<@${alert.mentionUserId}> 💸 **환전 타이밍입니다!!!!!**`,
          buildAlertEmbed(alert, snapshot),
          [alert.mentionUserId],
          alert.channelId,
        );
        log.info({ event: 'alert_sent', alertId: alert.id, rate: snapshot.rate }, '환율 알림 발송');
      } catch (caught) {
        const error = toError(caught);
        log.error(
          { event: 'alert_send_failed', alertId: alert.id, reason: error.message },
          '환율 알림 발송 실패 (수집은 계속됩니다)',
        );
        this.#healthRepo.record(
          'discord',
          'error',
          `알림 #${alert.id} 발송 실패: ${error.message}`,
        );
      }
    }
  }

  /** 복구 알림을 1회 발송한다. */
  async sendRecovery(snapshot: RateSnapshot): Promise<void> {
    if (this.#statusMessage === null) return;

    try {
      await this.#statusMessage.sendNotice(buildRecoveryEmbed(snapshot));
      log.info({ event: 'service_recovered' }, '복구 알림 발송');
    } catch (caught) {
      const error = toError(caught);
      log.error({ event: 'recovery_notice_failed', reason: error.message }, '복구 알림 발송 실패');
    }
  }
}
