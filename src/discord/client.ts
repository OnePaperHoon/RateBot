import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Channel,
  type SendableChannels,
} from 'discord.js';
import { DiscordConfigError } from '../errors.js';
import { childLogger, LogEvent } from '../logger.js';

const log = childLogger('discord');

/**
 * Discord 클라이언트 생성/로그인.
 *
 * Intent 최소화 (요구사항 11.3):
 *  - 일반 메시지 본문을 읽지 않으므로 MessageContent / GuildMembers / Presence 는 사용하지 않는다.
 *  - Slash Command 는 별도 intent 가 필요 없고, 채널에 메시지를 쓰려면 Guilds 만 있으면 된다.
 */
export function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds],
    // 상태 메시지가 캐시에 없어도 fetch 로 접근할 수 있게 partial 을 허용한다.
    partials: [Partials.Channel, Partials.Message],
  });
}

export interface LoginOptions {
  readonly token: string;
  /** ready 이벤트 대기 제한 시간. */
  readonly timeoutMs?: number;
}

/**
 * 로그인 후 ready 상태가 될 때까지 대기한다.
 *
 * 주의: `login()` 이 먼저 실패하면 `ready` 는 아무도 await 하지 않는 상태로 남는다.
 * 이때 타임아웃 타이머나 error 이벤트가 그 promise 를 reject 하면
 * unhandledRejection 이 되어 로그가 오염된다. 그래서
 *   · 실패 경로에서 타이머와 리스너를 즉시 정리하고
 *   · `ready` 에 미리 no-op catch 를 붙여 둔다.
 */
export async function loginAndWaitReady(
  client: Client,
  options: LoginOptions,
): Promise<Client<true>> {
  const timeoutMs = options.timeoutMs ?? 30_000;

  let cleanup = (): void => {};

  const ready = new Promise<Client<true>>((resolve, reject) => {
    const onReady = (readyClient: Client<true>): void => {
      cleanup();
      log.info(
        { event: LogEvent.DISCORD_CONNECTED, tag: readyClient.user.tag, id: readyClient.user.id },
        'Discord 로그인 완료',
      );
      resolve(readyClient);
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new DiscordConfigError(`Discord ready 이벤트가 ${timeoutMs}ms 안에 오지 않았습니다`));
    }, timeoutMs);
    timer.unref?.();

    cleanup = () => {
      clearTimeout(timer);
      client.off(Events.ClientReady, onReady);
      client.off(Events.Error, onError);
    };

    client.once(Events.ClientReady, onReady);
    client.once(Events.Error, onError);
  });

  // login 실패로 아무도 await 하지 않게 되더라도 unhandledRejection 이 되지 않게 한다.
  // (호출부가 await 하면 거부는 그대로 전달된다)
  ready.catch(() => undefined);

  try {
    await client.login(options.token);
  } catch (error) {
    cleanup();
    throw new DiscordConfigError(
      'Discord 로그인 실패 — DISCORD_TOKEN 이 올바른지 확인하세요 ' +
        '(Developer Portal > Bot > Reset Token)',
      { cause: error },
    );
  }

  return ready;
}

/** 텍스트 메시지를 보낼 수 있는 채널인지 좁힌다. */
export function isSendableTextChannel(channel: Channel | null): channel is SendableChannels {
  return channel !== null && channel.isTextBased() && channel.isSendable();
}

/**
 * 설정된 채널을 가져온다. 접근할 수 없으면 명확한 오류를 던진다.
 * (권한 문제는 재시도해도 해결되지 않으므로 DiscordConfigError 로 분류한다.)
 */
export async function fetchTargetChannel(
  client: Client,
  channelId: string,
): Promise<SendableChannels> {
  let channel: Channel | null;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (error) {
    throw new DiscordConfigError(
      `Discord 채널(${channelId})에 접근할 수 없습니다. ` +
        '봇이 서버에 초대됐는지, 채널에 "View Channels" 권한이 있는지 확인하세요.',
      { cause: error },
    );
  }

  if (!isSendableTextChannel(channel)) {
    throw new DiscordConfigError(
      `Discord 채널(${channelId})이 메시지를 보낼 수 있는 텍스트 채널이 아닙니다. ` +
        'DISCORD_CHANNEL_ID 를 다시 확인하세요.',
    );
  }

  return channel;
}

/** 클라이언트를 정상 종료한다. */
export async function destroyClient(client: Client): Promise<void> {
  try {
    await client.destroy();
    log.debug({ event: 'discord_destroyed' }, 'Discord 클라이언트 종료');
  } catch (error) {
    log.warn({ err: error }, 'Discord 클라이언트 종료 중 오류 (무시)');
  }
}
