#!/usr/bin/env tsx
/**
 * `npm run discord:register`
 *
 * 슬래시 커맨드를 Discord 에 등록한다.
 * 개발/개인용이므로 Guild Command 로 등록해 **즉시 반영**되게 한다.
 *
 * 옵션:
 *   --global   글로벌 커맨드로 등록 (반영까지 최대 1시간)
 *   --clear    등록된 커맨드를 모두 삭제
 */
import process from 'node:process';
import { formatEnvIssues, loadDotenv, validateEnv } from '../src/config/env.js';
import { commandDefinitions } from '../src/discord/commands.js';
import { clearSlashCommands, registerSlashCommands } from '../src/discord/registerCommands.js';
import { initLogger } from '../src/logger.js';
import { fail, heading, info, ok, print, table } from '../src/cli/ui.js';

async function main(): Promise<void> {
  initLogger({ level: 'info', pretty: true });
  heading('Discord 슬래시 커맨드 등록');

  loadDotenv();
  const validation = validateEnv();
  if (!validation.ok) {
    fail('환경변수 검증 실패');
    print();
    print(formatEnvIssues(validation.issues));
    process.exit(1);
  }
  const env = validation.env;

  const argv = process.argv.slice(2);
  const useGlobal = argv.includes('--global');
  const shouldClear = argv.includes('--clear');

  const options = {
    token: env.DISCORD_TOKEN,
    clientId: env.DISCORD_CLIENT_ID,
    ...(useGlobal ? {} : { guildId: env.DISCORD_GUILD_ID }),
  };

  try {
    if (shouldClear) {
      await clearSlashCommands(options);
      ok(`${useGlobal ? '글로벌' : '길드'} 커맨드를 모두 삭제했습니다.`);
      return;
    }

    print();
    print('  등록할 커맨드:');
    table(
      commandDefinitions().map(
        (command) => [`/${command.name}`, command.description ?? ''] as const,
      ),
      '    ',
    );
    print();

    const result = await registerSlashCommands(options);
    ok(
      `${result.scope === 'guild' ? '길드' : '글로벌'} 커맨드 ${result.commandNames.length}개 등록 완료`,
    );

    if (result.scope === 'guild') {
      info('길드 커맨드는 즉시 반영됩니다. Discord 에서 `/` 를 입력해 확인하세요.');
    } else {
      info('글로벌 커맨드는 반영까지 최대 1시간이 걸릴 수 있습니다.');
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();
