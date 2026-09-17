import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `.env` 파일 읽기/쓰기.
 *
 * 설계 의도:
 *  - 주석과 빈 줄, 키 순서를 **보존**한다. (사용자가 직접 작성한 설명이 사라지면 안 된다)
 *  - 값에 공백/`#`/따옴표가 들어가면 자동으로 따옴표를 씌운다.
 *  - 쓰기는 임시 파일 -> rename 으로 원자적으로 수행하고, 권한 600 을 유지한다.
 */

export const DEFAULT_ENV_PATH = path.resolve(process.cwd(), '.env');
export const DEFAULT_EXAMPLE_PATH = path.resolve(process.cwd(), '.env.example');

export interface EnvEntry {
  readonly key: string;
  readonly value: string;
}

const KEY_VALUE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** 따옴표와 인라인 주석을 제거해 실제 값을 얻는다. */
export function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  // 따옴표가 없을 때만 인라인 주석을 잘라낸다.
  const hashIndex = trimmed.indexOf(' #');
  return hashIndex >= 0 ? trimmed.slice(0, hashIndex).trim() : trimmed;
}

/** 필요할 때만 따옴표를 씌운다. */
export function quoteIfNeeded(value: string): string {
  if (value === '') return '';
  if (/^[A-Za-z0-9_\-./:@,+=]*$/.test(value)) return value;
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

/** 파일 존재 여부. */
export function envFileExists(filePath = DEFAULT_ENV_PATH): boolean {
  return fs.existsSync(filePath);
}

/** `.env` 를 key -> value 맵으로 읽는다. 없으면 빈 맵. */
export function readEnvFile(filePath = DEFAULT_ENV_PATH): Map<string, string> {
  const result = new Map<string, string>();
  if (!fs.existsSync(filePath)) return result;

  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const match = KEY_VALUE_RE.exec(line);
    if (match?.[1] === undefined) continue;
    result.set(match[1], unquote(match[2] ?? ''));
  }
  return result;
}

/**
 * 여러 키를 한 번에 갱신한다. 기존 줄은 제자리에서 수정하고,
 * 새 키는 파일 끝에 추가한다.
 */
export function updateEnvFile(
  updates: ReadonlyMap<string, string>,
  filePath = DEFAULT_ENV_PATH,
): void {
  if (updates.size === 0) return;

  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const lines = existing === '' ? [] : existing.split(/\r?\n/);
  const remaining = new Map(updates);

  const rewritten = lines.map((line) => {
    if (line.trim() === '' || line.trim().startsWith('#')) return line;
    const match = KEY_VALUE_RE.exec(line);
    const key = match?.[1];
    if (key === undefined || !remaining.has(key)) return line;

    const value = remaining.get(key) ?? '';
    remaining.delete(key);
    return `${key}=${quoteIfNeeded(value)}`;
  });

  if (remaining.size > 0) {
    if (rewritten.length > 0 && rewritten[rewritten.length - 1]?.trim() !== '') {
      rewritten.push('');
    }
    rewritten.push('# --- YenWatch CLI 로 추가된 값 ---');
    for (const [key, value] of remaining) {
      rewritten.push(`${key}=${quoteIfNeeded(value)}`);
    }
  }

  writeAtomic(filePath, `${rewritten.join('\n').replace(/\n+$/, '')}\n`);
}

/** `.env.example` 을 복사해 `.env` 를 만든다. 이미 있으면 아무것도 하지 않는다. */
export function createEnvFromExample(
  envPath = DEFAULT_ENV_PATH,
  examplePath = DEFAULT_EXAMPLE_PATH,
): 'created' | 'exists' | 'no-example' {
  if (fs.existsSync(envPath)) return 'exists';
  if (!fs.existsSync(examplePath)) return 'no-example';

  // 예시의 가짜 토큰이 그대로 남지 않도록 값은 비우고 주석/구조만 가져온다.
  const example = fs.readFileSync(examplePath, 'utf8');
  const blanked = example
    .split(/\r?\n/)
    .map((line) => {
      const match = KEY_VALUE_RE.exec(line);
      const key = match?.[1];
      if (key === undefined) return line;
      // 값이 비밀정보가 아닌 설정 기본값이면 유지한다.
      return SAFE_DEFAULT_KEYS.has(key) ? line : `${key}=`;
    })
    .join('\n');

  writeAtomic(envPath, blanked);
  return 'created';
}

/** 예시 파일의 값을 그대로 써도 안전한(비밀이 아닌) 키. */
const SAFE_DEFAULT_KEYS: ReadonlySet<string> = new Set([
  'NODE_ENV',
  'TZ',
  'LOG_LEVEL',
  'NOTION_ENABLED',
  'NOTION_HISTORY_ENABLED',
  'NOTION_HISTORY_INTERVAL_MINUTES',
  'NAVER_JPY_API_URL',
  'NAVER_JPY_URL',
  'SCRAPE_INTERVAL_SECONDS',
  'REQUEST_TIMEOUT_MS',
  'STALE_AFTER_MINUTES',
  'FAILURE_ALERT_THRESHOLD',
  'MIN_VALID_JPY100_KRW',
  'MAX_VALID_JPY100_KRW',
  'SQLITE_PATH',
  'DATA_RETENTION_DAYS',
]);

/** 파일 권한이 600 인지 확인한다 (Windows 에서는 항상 true). */
export function hasSecurePermissions(filePath = DEFAULT_ENV_PATH): boolean {
  if (os.platform() === 'win32') return true;
  if (!fs.existsSync(filePath)) return true;
  const mode = fs.statSync(filePath).mode & 0o777;
  return mode === 0o600;
}

/** 권한을 600 으로 바꾼다. Windows 에서는 무시된다. */
export function securePermissions(filePath = DEFAULT_ENV_PATH): boolean {
  if (os.platform() === 'win32') return false;
  if (!fs.existsSync(filePath)) return false;
  fs.chmodSync(filePath, 0o600);
  return true;
}

/** 임시 파일 -> rename 으로 원자적 쓰기. 실패해도 원본이 깨지지 않는다. */
function writeAtomic(filePath: string, content: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });

  const tempPath = path.join(directory, `.env.tmp-${process.pid}`);
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempPath, filePath);

  if (os.platform() !== 'win32') {
    fs.chmodSync(filePath, 0o600);
  }
}
