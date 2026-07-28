#!/usr/bin/env tsx
/**
 * `npm run check`
 *
 * 배포 전/후 점검 스크립트. 외부 서비스를 실제로 호출해 다음을 확인한다.
 *   1. 환경변수 검증
 *   2. SQLite 열기 / 마이그레이션 / 무결성
 *   3. 네이버 금융 수집 (저장하지 않음)
 *   4. Discord 로그인 및 채널 접근 권한
 *   5. Notion 연결 및 스키마
 *
 * 실패한 항목이 있으면 exit code 1 을 반환하므로 CI/스크립트에서 활용할 수 있다.
 */
import process from 'node:process';
import { validateEnv, formatEnvIssues, loadDotenv } from '../src/config/env.js';
import { checkIntegrity, closeDatabase, openDatabase } from '../src/database/client.js';
import { RateRepository } from '../src/database/rateRepository.js';
import {
  createDiscordClient,
  destroyClient,
  fetchTargetChannel,
  loginAndWaitReady,
} from '../src/discord/client.js';
import { NaverJpyScraper } from '../src/scraper/naverJpyScraper.js';
import {
  checkConnection,
  createNotionClient,
  describeNotionError,
  fetchAndValidateDataSource,
} from '../src/notion/client.js';
import { HISTORY_PROPERTIES, STATUS_PROPERTIES } from '../src/notion/schema.js';
import { NotionSchemaError } from '../src/errors.js';
import { initLogger } from '../src/logger.js';
import { formatRate } from '../src/utils/money.js';
import { color, fail, heading, info, ok, print, table, warn } from '../src/cli/ui.js';
import { APP_VERSION } from '../src/version.js';

interface CheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const results: CheckResult[] = [];

function record(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
  if (passed) ok(`${name} — ${detail}`);
  else fail(`${name} — ${detail}`);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function main(): Promise<void> {
  initLogger({ level: 'error', pretty: true });
  heading(`YenWatch 헬스 체크 v${APP_VERSION}`);

  // ---------- 1. 환경변수 ----------
  loadDotenv();
  const validation = validateEnv();
  if (!validation.ok) {
    fail('환경변수 검증 실패');
    print();
    print(formatEnvIssues(validation.issues));
    process.exit(1);
  }
  const env = validation.env;
  record('환경변수', true, '모든 필수 값이 올바릅니다');

  // ---------- 2. SQLite ----------
  try {
    const db = openDatabase({ filePath: env.SQLITE_PATH });
    try {
      const integrity = checkIntegrity(db);
      const count = new RateRepository(db).count();
      record(
        'SQLite',
        integrity === 'ok',
        integrity === 'ok'
          ? `정상 (${count.toLocaleString('ko-KR')}건, ${env.SQLITE_PATH})`
          : `무결성 검사 결과: ${integrity}`,
      );
    } finally {
      closeDatabase(db);
    }
  } catch (error) {
    record('SQLite', false, describeError(error));
  }

  // ---------- 3. 네이버 수집 ----------
  try {
    const scraper = new NaverJpyScraper({
      url: env.NAVER_JPY_URL,
      timeoutMs: env.REQUEST_TIMEOUT_MS,
      minValid: env.MIN_VALID_JPY100_KRW,
      maxValid: env.MAX_VALID_JPY100_KRW,
    });
    const startedAt = Date.now();
    const result = await scraper.fetchRate();
    record(
      '네이버 환율 수집',
      true,
      `100 JPY = ${formatRate(result.rate)} KRW (파서: ${result.parser}, ${Date.now() - startedAt}ms)`,
    );
  } catch (error) {
    record('네이버 환율 수집', false, describeError(error));
  }

  // ---------- 4. Discord ----------
  const discord = createDiscordClient();
  try {
    const ready = await loginAndWaitReady(discord, { token: env.DISCORD_TOKEN });
    record('Discord 로그인', true, `${ready.user.tag} (id=${ready.user.id})`);

    try {
      const channel = await fetchTargetChannel(discord, env.DISCORD_CHANNEL_ID);
      const channelName =
        'name' in channel && channel.name ? `#${channel.name}` : env.DISCORD_CHANNEL_ID;
      record('Discord 채널 접근', true, `${channelName} 에 메시지를 보낼 수 있습니다`);
    } catch (error) {
      record('Discord 채널 접근', false, describeError(error));
    }
  } catch (error) {
    record('Discord 로그인', false, describeError(error));
  } finally {
    await destroyClient(discord);
  }

  // ---------- 5. Notion ----------
  if (!env.NOTION_ENABLED) {
    info('Notion 은 비활성화되어 있습니다 (NOTION_ENABLED=false) — 건너뜁니다.');
  } else {
    const notion = createNotionClient({ token: env.NOTION_TOKEN });
    const connection = await checkConnection(notion);
    record(
      'Notion 연결',
      connection.ok,
      connection.ok
        ? `integration: ${connection.botName ?? '(이름 없음)'}`
        : (connection.error ?? '알 수 없는 오류'),
    );

    if (connection.ok) {
      try {
        const { validation: schema } = await fetchAndValidateDataSource(
          notion,
          env.NOTION_DATA_SOURCE_ID,
          STATUS_PROPERTIES,
          '상태 데이터베이스',
        );
        record('Notion 상태 스키마', true, `"${schema.title}" 속성 ${schema.actual.length}개 확인`);
      } catch (error) {
        if (error instanceof NotionSchemaError) {
          record('Notion 상태 스키마', false, error.message);
          print();
          print(error.report);
          print();
        } else {
          record('Notion 상태 스키마', false, describeNotionError(error));
        }
      }

      if (env.NOTION_HISTORY_ENABLED) {
        try {
          const { validation: schema } = await fetchAndValidateDataSource(
            notion,
            env.NOTION_HISTORY_DATA_SOURCE_ID,
            HISTORY_PROPERTIES,
            '이력 데이터베이스',
          );
          record(
            'Notion 이력 스키마',
            true,
            `"${schema.title}" 속성 ${schema.actual.length}개 확인`,
          );
        } catch (error) {
          if (error instanceof NotionSchemaError) {
            record('Notion 이력 스키마', false, error.message);
            print();
            print(error.report);
            print();
          } else {
            record('Notion 이력 스키마', false, describeNotionError(error));
          }
        }
      }
    }
  }

  // ---------- 요약 ----------
  heading('결과 요약');
  table(
    results.map(
      (result) => [result.name, result.passed ? color.green('통과') : color.red('실패')] as const,
    ),
  );

  const failures = results.filter((result) => !result.passed);
  print();
  if (failures.length === 0) {
    ok(`모든 점검을 통과했습니다 (${results.length}/${results.length})`);
    print();
    info('다음 단계: npm run discord:register  →  npm start');
    process.exit(0);
  }

  warn(`${failures.length}개 항목이 실패했습니다.`);
  print();
  info('문제 해결: npm run cli  로 각 항목을 개별 점검할 수 있습니다.');
  process.exit(1);
}

void main().catch((error: unknown) => {
  fail(`헬스 체크 실행 중 오류: ${describeError(error)}`);
  process.exit(1);
});
