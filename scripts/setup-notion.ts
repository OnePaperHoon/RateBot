#!/usr/bin/env tsx
/**
 * `npm run notion:check`
 *
 * Notion 연결 상태와 데이터 소스 스키마를 점검한다.
 * 출력 항목 (요구사항 12.2):
 *   · 연결 성공 여부
 *   · 데이터 소스 제목
 *   · 데이터 소스 ID
 *   · 속성명 / 속성 타입
 *   · 필요한 속성 누락 여부와 수정 방법
 */
import process from 'node:process';
import { formatEnvIssues, loadDotenv, validateEnv } from '../src/config/env.js';
import { NotionSchemaError } from '../src/errors.js';
import { initLogger } from '../src/logger.js';
import {
  checkConnection,
  createNotionClient,
  describeNotionError,
  fetchAndValidateDataSource,
} from '../src/notion/client.js';
import {
  HISTORY_PROPERTIES,
  STATUS_PROPERTIES,
  formatSchemaReport,
  type PropertySpec,
} from '../src/notion/schema.js';
import { color, fail, heading, info, ok, print, table } from '../src/cli/ui.js';

let hasFailure = false;

async function inspect(
  client: ReturnType<typeof createNotionClient>,
  dataSourceId: string,
  required: readonly PropertySpec[],
  label: string,
): Promise<void> {
  print();
  try {
    const { validation } = await fetchAndValidateDataSource(client, dataSourceId, required, label);
    print(formatSchemaReport(validation, label));
  } catch (error) {
    hasFailure = true;
    if (error instanceof NotionSchemaError) {
      print(error.report);
      return;
    }
    fail(`[${label}] 점검 실패: ${describeNotionError(error)}`);
  }
}

async function main(): Promise<void> {
  initLogger({ level: 'error', pretty: true });
  heading('Notion 연동 점검');

  loadDotenv();
  const validation = validateEnv();
  if (!validation.ok) {
    fail('환경변수 검증 실패');
    print();
    print(formatEnvIssues(validation.issues));
    process.exit(1);
  }
  const env = validation.env;

  if (!env.NOTION_ENABLED) {
    info('NOTION_ENABLED=false 이므로 Notion 을 사용하지 않습니다.');
    info('사용하려면 `.env` 에서 NOTION_ENABLED=true 로 바꾸세요.');
    process.exit(0);
  }

  const client = createNotionClient({ token: env.NOTION_TOKEN });

  const connection = await checkConnection(client);
  if (!connection.ok) {
    fail(`연결 실패: ${connection.error ?? '알 수 없는 오류'}`);
    print();
    print('  확인 사항:');
    print('    1. NOTION_TOKEN 이 Internal Integration Secret 인지 (ntn_ / secret_ 로 시작)');
    print('    2. Integration 이 삭제되지 않았는지');
    print('    3. https://www.notion.so/my-integrations 에서 토큰을 재발급해 보세요');
    process.exit(1);
  }

  ok(`연결 성공${connection.botName ? ` — integration: ${color.bold(connection.botName)}` : ''}`);

  await inspect(client, env.NOTION_DATA_SOURCE_ID, STATUS_PROPERTIES, '상태 데이터베이스');

  if (env.NOTION_HISTORY_ENABLED) {
    await inspect(
      client,
      env.NOTION_HISTORY_DATA_SOURCE_ID,
      HISTORY_PROPERTIES,
      '이력 데이터베이스',
    );
  } else {
    print();
    info('NOTION_HISTORY_ENABLED=false — 이력 데이터베이스는 점검하지 않습니다.');
  }

  heading('요약');
  table([
    ['연결', hasFailure ? color.yellow('성공 (스키마 문제 있음)') : color.green('성공')],
    ['상태 DB', env.NOTION_DATA_SOURCE_ID],
    ['이력 DB', env.NOTION_HISTORY_ENABLED ? env.NOTION_HISTORY_DATA_SOURCE_ID : '사용 안 함'],
  ]);

  print();
  if (hasFailure) {
    fail('스키마 문제를 해결한 뒤 다시 실행하세요: npm run notion:check');
    process.exit(1);
  }
  ok('Notion 설정이 완료되었습니다.');
  process.exit(0);
}

void main().catch((error: unknown) => {
  fail(`점검 중 오류: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
