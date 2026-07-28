import { REST, Routes } from 'discord.js';
import { DiscordConfigError } from '../errors.js';
import { childLogger } from '../logger.js';
import { commandDefinitions } from './commands.js';

const log = childLogger('discord-register');

export interface RegisterCommandsOptions {
  readonly token: string;
  readonly clientId: string;
  /**
   * 길드 ID. 지정하면 Guild Command 로 등록되어 **즉시 반영**된다.
   * (Global Command 는 반영까지 최대 1시간이 걸리므로 개발/개인용에는 부적합)
   */
  readonly guildId?: string;
}

export interface RegisterResult {
  readonly scope: 'guild' | 'global';
  readonly commandNames: readonly string[];
}

/**
 * 슬래시 커맨드를 Discord 에 등록한다.
 *
 * `npm run discord:register` 로 실행한다. 봇 실행과 분리되어 있어
 * 커맨드 정의가 바뀌었을 때만 다시 실행하면 된다.
 */
export async function registerSlashCommands(
  options: RegisterCommandsOptions,
): Promise<RegisterResult> {
  const body = commandDefinitions();
  const rest = new REST({ version: '10' }).setToken(options.token);

  const route =
    options.guildId !== undefined && options.guildId !== ''
      ? Routes.applicationGuildCommands(options.clientId, options.guildId)
      : Routes.applicationCommands(options.clientId);

  const scope: RegisterResult['scope'] = options.guildId ? 'guild' : 'global';

  try {
    await rest.put(route, { body });
  } catch (error) {
    throw new DiscordConfigError(
      [
        '슬래시 커맨드 등록에 실패했습니다.',
        '  확인 사항:',
        '    1. DISCORD_TOKEN 이 유효한지',
        '    2. DISCORD_CLIENT_ID 가 Application ID 와 일치하는지',
        '    3. DISCORD_GUILD_ID 서버에 봇이 초대돼 있는지',
        '    4. 초대 URL 의 scope 에 `applications.commands` 가 포함됐는지',
      ].join('\n'),
      { cause: error },
    );
  }

  const commandNames = body.map((command) => command.name);
  log.info(
    { event: 'commands_registered', scope, count: commandNames.length, commandNames },
    '슬래시 커맨드 등록 완료',
  );

  return { scope, commandNames };
}

/** 등록된 커맨드를 모두 제거한다 (문제 해결용). */
export async function clearSlashCommands(options: RegisterCommandsOptions): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(options.token);
  const route =
    options.guildId !== undefined && options.guildId !== ''
      ? Routes.applicationGuildCommands(options.clientId, options.guildId)
      : Routes.applicationCommands(options.clientId);

  await rest.put(route, { body: [] });
  log.info({ event: 'commands_cleared' }, '슬래시 커맨드 전체 삭제');
}
