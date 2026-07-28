import {
  DiscordAPIError,
  RESTJSONErrorCodes,
  type Client,
  type EmbedBuilder,
  type Message,
} from 'discord.js';
import { DiscordConfigError } from '../errors.js';
import { childLogger, LogEvent } from '../logger.js';
import { SettingKey, type SettingsRepository } from '../database/settingsRepository.js';
import { fetchTargetChannel } from './client.js';

const log = childLogger('discord-status');

/** 메시지가 사라졌다고 판단할 Discord API 오류 코드. */
const MISSING_MESSAGE_CODES: ReadonlySet<number> = new Set([
  RESTJSONErrorCodes.UnknownMessage,
  RESTJSONErrorCodes.UnknownChannel,
]);

/** 권한 문제로 판단할 오류 코드. */
const PERMISSION_CODES: ReadonlySet<number> = new Set([
  RESTJSONErrorCodes.MissingAccess,
  RESTJSONErrorCodes.MissingPermissions,
  RESTJSONErrorCodes.CannotSendMessagesInNonTextChannel,
]);

export interface StatusMessageManagerDeps {
  readonly client: Client;
  readonly channelId: string;
  readonly settings: SettingsRepository;
}

/**
 * 하나의 상태 메시지를 계속 "수정" 하는 매니저.
 *
 * 요구사항 3.1:
 *   1. 최초 실행 시 메시지 생성
 *   2. 메시지 ID 를 SQLite 에 저장
 *   3. 이후에는 기존 메시지를 수정
 *   4. 메시지가 삭제/접근 불가면 새로 생성
 *   5. 새 ID 를 다시 저장
 */
export class StatusMessageManager {
  readonly #client: Client;
  readonly #channelId: string;
  readonly #settings: SettingsRepository;

  #cachedMessage: Message | null = null;

  constructor(deps: StatusMessageManagerDeps) {
    this.#client = deps.client;
    this.#channelId = deps.channelId;
    this.#settings = deps.settings;
  }

  /** 현재 추적 중인 메시지 ID. */
  get messageId(): string | null {
    return this.#cachedMessage?.id ?? this.#settings.get(SettingKey.DISCORD_MESSAGE_ID);
  }

  /**
   * 상태 메시지를 갱신한다. 없으면 생성한다.
   *
   * @throws {DiscordConfigError} 권한 부족 등 재시도해도 소용없는 오류
   */
  async update(embed: EmbedBuilder): Promise<Message> {
    const existing = await this.#resolveMessage();

    if (existing !== null) {
      try {
        const edited = await existing.edit({ embeds: [embed] });
        this.#cachedMessage = edited;
        log.debug(
          { event: LogEvent.DISCORD_MESSAGE_UPDATED, messageId: edited.id },
          '상태 메시지 수정',
        );
        return edited;
      } catch (error) {
        if (isPermissionError(error)) throw toPermissionError(error, this.#channelId);
        if (!isMissingMessageError(error)) throw error;

        log.warn(
          { event: 'discord_message_missing', messageId: existing.id },
          '상태 메시지가 사라졌습니다 — 새로 생성합니다',
        );
        this.#forget();
      }
    }

    return this.#createMessage(embed);
  }

  /** 별도 알림(경고/복구)을 새 메시지로 보낸다. 상태 메시지와 섞이지 않는다. */
  async sendNotice(embed: EmbedBuilder): Promise<Message> {
    const channel = await fetchTargetChannel(this.#client, this.#channelId);
    try {
      return await channel.send({ embeds: [embed] });
    } catch (error) {
      if (isPermissionError(error)) throw toPermissionError(error, this.#channelId);
      throw error;
    }
  }

  async #createMessage(embed: EmbedBuilder): Promise<Message> {
    const channel = await fetchTargetChannel(this.#client, this.#channelId);

    let message: Message;
    try {
      message = await channel.send({ embeds: [embed] });
    } catch (error) {
      if (isPermissionError(error)) throw toPermissionError(error, this.#channelId);
      throw error;
    }

    this.#cachedMessage = message;
    this.#settings.set(SettingKey.DISCORD_MESSAGE_ID, message.id);
    log.info(
      {
        event: LogEvent.DISCORD_MESSAGE_CREATED,
        messageId: message.id,
        channelId: this.#channelId,
      },
      '상태 메시지 생성',
    );
    return message;
  }

  /** 캐시 -> SQLite 저장 ID -> fetch 순으로 기존 메시지를 찾는다. */
  async #resolveMessage(): Promise<Message | null> {
    if (this.#cachedMessage !== null) return this.#cachedMessage;

    const storedId = this.#settings.get(SettingKey.DISCORD_MESSAGE_ID);
    if (storedId === null || storedId.trim() === '') return null;

    const channel = await fetchTargetChannel(this.#client, this.#channelId);

    try {
      const message = await channel.messages.fetch(storedId);
      this.#cachedMessage = message;
      return message;
    } catch (error) {
      if (isMissingMessageError(error)) {
        log.warn(
          { event: 'discord_message_not_found', messageId: storedId },
          '저장된 상태 메시지를 찾을 수 없습니다 — 새로 생성합니다',
        );
        this.#forget();
        return null;
      }
      if (isPermissionError(error)) throw toPermissionError(error, this.#channelId);
      throw error;
    }
  }

  #forget(): void {
    this.#cachedMessage = null;
    this.#settings.delete(SettingKey.DISCORD_MESSAGE_ID);
  }
}

function isMissingMessageError(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError &&
    typeof error.code === 'number' &&
    MISSING_MESSAGE_CODES.has(error.code)
  );
}

function isPermissionError(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError &&
    typeof error.code === 'number' &&
    PERMISSION_CODES.has(error.code)
  );
}

function toPermissionError(error: unknown, channelId: string): DiscordConfigError {
  return new DiscordConfigError(
    `Discord 채널(${channelId}) 권한이 부족합니다. ` +
      '봇 역할에 View Channels / Send Messages / Embed Links / Read Message History 권한을 부여하세요.',
    { cause: error },
  );
}
