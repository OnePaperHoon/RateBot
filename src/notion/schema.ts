import type { GetDataSourceResponse } from '@notionhq/client';

/**
 * Notion 데이터 소스 스키마 정의 및 검증.
 *
 * 요구사항 4.1: 속성 이름이 맞지 않아도 즉시 종료하지 않고
 *   - 실제 속성 목록
 *   - 누락된 속성
 *   - 타입이 잘못된 속성
 *   - 수정 방법
 * 을 출력한다.
 */

export interface PropertySpec {
  readonly name: string;
  readonly type: string;
  readonly description: string;
}

/** 상태 데이터베이스에 필요한 속성. */
export const STATUS_PROPERTIES: readonly PropertySpec[] = [
  { name: 'Name', type: 'title', description: 'YenWatch (행 제목)' },
  { name: 'Rate', type: 'number', description: '100엔당 원화' },
  { name: 'Change', type: 'number', description: '전회 대비 변화량' },
  { name: 'Change Percent', type: 'number', description: '전회 대비 변화율(%)' },
  { name: 'Daily High', type: 'number', description: '당일 최고' },
  { name: 'Daily Low', type: 'number', description: '당일 최저' },
  { name: 'Collected At', type: 'date', description: '수집 시각' },
  { name: 'Status', type: 'select', description: '정상 또는 오류' },
  { name: 'Source', type: 'url', description: '네이버 금융 URL' },
];

/** 이력 데이터베이스에 필요한 속성 (Status 없음). */
export const HISTORY_PROPERTIES: readonly PropertySpec[] = STATUS_PROPERTIES.filter(
  (property) => property.name !== 'Status',
);

/** 상태 Select 옵션 값. */
export const STATUS_OK = '정상';
export const STATUS_ERROR = '오류';

/** 데이터 소스에서 읽어낸 실제 속성. */
export interface ActualProperty {
  readonly name: string;
  readonly type: string;
}

export interface SchemaValidation {
  readonly ok: boolean;
  readonly title: string;
  readonly dataSourceId: string;
  readonly actual: readonly ActualProperty[];
  /** 아예 없는 속성. */
  readonly missing: readonly PropertySpec[];
  /** 이름은 있지만 타입이 다른 속성. */
  readonly mismatched: readonly {
    readonly spec: PropertySpec;
    readonly actualType: string;
  }[];
}

interface PropertyConfigLike {
  readonly type?: unknown;
}

/** SDK 의 넓은 union 타입에서 우리가 쓰는 부분만 좁혀 읽는다. */
export function extractProperties(dataSource: GetDataSourceResponse): ActualProperty[] {
  if (!('properties' in dataSource) || typeof dataSource.properties !== 'object') {
    return [];
  }
  const properties = dataSource.properties as Record<string, PropertyConfigLike>;
  return Object.entries(properties).map(([name, config]) => ({
    name,
    type: typeof config?.type === 'string' ? config.type : 'unknown',
  }));
}

/** 데이터 소스 제목(평문). */
export function extractTitle(dataSource: GetDataSourceResponse): string {
  if (!('title' in dataSource) || !Array.isArray(dataSource.title)) return '(제목 없음)';
  const parts = dataSource.title
    .map((item) => (typeof item?.plain_text === 'string' ? item.plain_text : ''))
    .join('')
    .trim();
  return parts === '' ? '(제목 없음)' : parts;
}

/** 필요한 속성이 모두 존재하고 타입이 맞는지 검사한다. */
export function validateSchema(
  dataSource: GetDataSourceResponse,
  required: readonly PropertySpec[],
): SchemaValidation {
  const actual = extractProperties(dataSource);
  const byName = new Map(actual.map((property) => [property.name, property]));

  const missing: PropertySpec[] = [];
  const mismatched: { spec: PropertySpec; actualType: string }[] = [];

  for (const spec of required) {
    const found = byName.get(spec.name);
    if (!found) {
      missing.push(spec);
      continue;
    }
    if (found.type !== spec.type) {
      mismatched.push({ spec, actualType: found.type });
    }
  }

  return {
    ok: missing.length === 0 && mismatched.length === 0,
    title: extractTitle(dataSource),
    dataSourceId:
      'id' in dataSource && typeof dataSource.id === 'string' ? dataSource.id : '(알 수 없음)',
    actual,
    missing,
    mismatched,
  };
}

/** 사람이 읽고 바로 고칠 수 있는 형태의 진단 리포트. */
export function formatSchemaReport(validation: SchemaValidation, label: string): string {
  const lines: string[] = [];

  lines.push(`[${label}] Notion 데이터 소스 스키마 점검`);
  lines.push(`  제목      : ${validation.title}`);
  lines.push(`  ID        : ${validation.dataSourceId}`);
  lines.push('');
  lines.push('  실제 속성 목록:');
  if (validation.actual.length === 0) {
    lines.push(
      '    (속성을 읽지 못했습니다 — integration 이 이 데이터베이스에 연결됐는지 확인하세요)',
    );
  } else {
    for (const property of validation.actual) {
      lines.push(`    - ${property.name}  (${property.type})`);
    }
  }

  if (validation.missing.length > 0) {
    lines.push('');
    lines.push('  ✗ 누락된 속성:');
    for (const spec of validation.missing) {
      lines.push(`    - "${spec.name}"  타입: ${spec.type}   — ${spec.description}`);
    }
  }

  if (validation.mismatched.length > 0) {
    lines.push('');
    lines.push('  ✗ 타입이 잘못된 속성:');
    for (const item of validation.mismatched) {
      lines.push(
        `    - "${item.spec.name}"  현재: ${item.actualType}  →  필요: ${item.spec.type}   — ${item.spec.description}`,
      );
    }
  }

  if (validation.ok) {
    lines.push('');
    lines.push('  ✓ 모든 필수 속성이 올바르게 설정되어 있습니다.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('  수정 방법:');
  lines.push('    1. Notion 에서 해당 데이터베이스를 엽니다.');
  lines.push(
    '    2. 표 오른쪽 끝 "+" 로 속성을 추가하거나, 속성 헤더를 클릭해 이름/타입을 수정합니다.',
  );
  lines.push('       (속성 이름은 대소문자와 공백까지 정확히 일치해야 합니다)');
  lines.push('    3. 우측 상단 "..." → "연결" → YenWatch integration 이 연결됐는지 확인합니다.');
  lines.push('    4. 다시 검사: npm run notion:check');

  return lines.join('\n');
}
