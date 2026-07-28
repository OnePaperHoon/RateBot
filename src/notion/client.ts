import {
  APIResponseError,
  Client,
  isNotionClientError,
  type GetDataSourceResponse,
} from '@notionhq/client';
import { childLogger, LogEvent } from '../logger.js';
import { NotionSchemaError } from '../errors.js';
import {
  formatSchemaReport,
  validateSchema,
  type PropertySpec,
  type SchemaValidation,
} from './schema.js';

const log = childLogger('notion');

/**
 * Notion API 클라이언트 래퍼.
 *
 * - 모든 요청에 타임아웃을 강제한다.
 * - 페이지가 삭제된 경우(object_not_found) 를 호출부가 구분할 수 있게 헬퍼를 제공한다.
 * - 토큰은 절대 로그에 남기지 않는다.
 */

export interface NotionClientConfig {
  readonly token: string;
  readonly timeoutMs?: number;
}

export function createNotionClient(config: NotionClientConfig): Client {
  return new Client({
    auth: config.token,
    timeoutMs: config.timeoutMs ?? 15_000,
    // SDK 자체 재시도는 끄고, 상위 서비스의 재시도 정책에 맡긴다.
    retry: { maxRetries: 0 },
  });
}

/** 대상 페이지/데이터소스를 찾을 수 없는 오류인가 (삭제됨 또는 미공유). */
export function isObjectNotFound(error: unknown): boolean {
  return (
    APIResponseError.isAPIResponseError(error) &&
    (error.code === 'object_not_found' || error.status === 404)
  );
}

/** 권한 부족 오류인가 (integration 이 DB 에 연결되지 않음). */
export function isUnauthorized(error: unknown): boolean {
  return (
    APIResponseError.isAPIResponseError(error) &&
    (error.code === 'unauthorized' || error.code === 'restricted_resource' || error.status === 401)
  );
}

/** 재시도할 가치가 있는 Notion 오류인가 (rate limit / 5xx / 타임아웃). */
export function isRetryableNotionError(error: unknown): boolean {
  if (!isNotionClientError(error)) return false;
  if (APIResponseError.isAPIResponseError(error)) {
    return error.status === 429 || error.status >= 500;
  }
  // RequestTimeoutError 등 네트워크 계층 오류
  return true;
}

/** 로그에 남겨도 안전한 형태의 오류 요약. */
export function describeNotionError(error: unknown): string {
  if (APIResponseError.isAPIResponseError(error)) {
    return `${error.code} (HTTP ${error.status}): ${error.message}`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export interface ConnectionCheck {
  readonly ok: boolean;
  readonly botName: string | null;
  readonly error: string | null;
}

/** Integration 토큰이 유효한지 확인한다. */
export async function checkConnection(client: Client): Promise<ConnectionCheck> {
  try {
    const me = await client.users.me({});
    const botName = 'name' in me && typeof me.name === 'string' ? me.name : null;
    log.info({ event: LogEvent.NOTION_CONNECTED, botName }, 'Notion 연결 확인');
    return { ok: true, botName, error: null };
  } catch (error) {
    return { ok: false, botName: null, error: describeNotionError(error) };
  }
}

/**
 * 데이터 소스를 조회하고 스키마를 검증한다.
 *
 * 검증 실패 시 NotionSchemaError 를 던지며, 오류 메시지에 수정 방법이 담긴다.
 * (요구사항 4.1 — 즉시 종료하지 말고 진단 정보를 출력할 것)
 */
export async function fetchAndValidateDataSource(
  client: Client,
  dataSourceId: string,
  required: readonly PropertySpec[],
  label: string,
): Promise<{ dataSource: GetDataSourceResponse; validation: SchemaValidation }> {
  let dataSource: GetDataSourceResponse;
  try {
    dataSource = await client.dataSources.retrieve({ data_source_id: dataSourceId });
  } catch (error) {
    if (isObjectNotFound(error)) {
      throw new NotionSchemaError(
        `[${label}] 데이터 소스를 찾을 수 없습니다`,
        [
          `[${label}] Notion 데이터 소스 조회 실패`,
          `  ID: ${dataSourceId}`,
          '',
          '  가능한 원인:',
          '    1. NOTION_DATA_SOURCE_ID 가 database ID 입니다. data source ID 가 필요합니다.',
          '    2. 해당 데이터베이스에 YenWatch integration 이 연결되지 않았습니다.',
          '       Notion 에서 데이터베이스 → "..." → 연결 → YenWatch 를 추가하세요.',
          '    3. ID 에 오타가 있습니다.',
          '',
          '  확인 명령: npm run notion:check',
        ].join('\n'),
      );
    }
    if (isUnauthorized(error)) {
      throw new NotionSchemaError(
        `[${label}] Notion 접근 권한이 없습니다`,
        [
          `[${label}] Notion 권한 오류: ${describeNotionError(error)}`,
          '',
          '  확인 사항:',
          '    1. NOTION_TOKEN 이 올바른 Internal Integration Secret 인지',
          '    2. Integration 에 Read / Insert / Update content 권한이 켜져 있는지',
          '    3. 대상 데이터베이스에 integration 이 연결되어 있는지',
        ].join('\n'),
      );
    }
    throw error;
  }

  const validation = validateSchema(dataSource, required);
  if (!validation.ok) {
    throw new NotionSchemaError(
      `[${label}] Notion 속성 구성이 올바르지 않습니다`,
      formatSchemaReport(validation, label),
    );
  }

  return { dataSource, validation };
}
