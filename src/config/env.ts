import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { z } from 'zod';
import { ConfigError } from '../errors.js';

/**
 * 환경변수 로딩 및 검증.
 *
 * - `.env` 는 프로세스 시작 시 1회 로드된다. (systemd 는 EnvironmentFile 로 주입하므로
 *   .env 가 없어도 정상 동작한다.)
 * - 검증은 Zod 로 수행하며, 실패 시 사람이 읽을 수 있는 오류를 출력하고 종료한다.
 * - CLI 는 `validateEnv()` 를 직접 호출해 프로세스를 죽이지 않고 진단만 수행한다.
 */

/** 쉼표 구분 문자열 -> 문자열 배열 */
const csvList = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

/** "true"/"1"/"yes"/"on" 을 true 로 해석 */
const booleanish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return defaultValue;
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
      return defaultValue;
    });

/** 숫자 문자열 -> number (빈 문자열이면 기본값) */
const numberish = (
  defaultValue: number,
  opts: { min?: number; max?: number; int?: boolean } = {},
) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? defaultValue : value))
    .pipe(
      z.coerce
        .number({ invalid_type_error: '숫자여야 합니다' })
        .refine((n) => Number.isFinite(n), { message: '유한한 숫자여야 합니다' })
        .refine((n) => (opts.int ? Number.isInteger(n) : true), { message: '정수여야 합니다' })
        .refine((n) => (opts.min === undefined ? true : n >= opts.min), {
          message: `${opts.min} 이상이어야 합니다`,
        })
        .refine((n) => (opts.max === undefined ? true : n <= opts.max), {
          message: `${opts.max} 이하여야 합니다`,
        }),
    );

/** Discord 스노우플레이크 ID (17~20자리 숫자) */
const snowflake = z
  .string({ required_error: '값이 없습니다 — `.env` 에 설정하세요 (npm run cli)' })
  .min(1, 'Discord ID 가 비어 있습니다')
  .regex(/^\d{17,20}$/, '17~20자리 숫자 형식의 Discord ID 여야 합니다');

const DEFAULT_NAVER_URL =
  'https://finance.naver.com/marketindex/exchangeDetail.naver?marketindexCd=FX_JPYKRW';

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
    TZ: z.string().default('Asia/Seoul'),
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),

    // ---------- Discord ----------
    DISCORD_TOKEN: z
      .string({
        required_error: '값이 없습니다 — Developer Portal > Bot > Reset Token 으로 발급하세요',
      })
      .min(20, 'Discord 봇 토큰이 너무 짧습니다'),
    DISCORD_CLIENT_ID: snowflake,
    DISCORD_GUILD_ID: snowflake,
    DISCORD_CHANNEL_ID: snowflake,
    DISCORD_ALLOWED_USER_IDS: csvList,

    // ---------- Notion (상태) ----------
    NOTION_ENABLED: booleanish(true),
    NOTION_TOKEN: z.string().optional().default(''),
    NOTION_DATA_SOURCE_ID: z.string().optional().default(''),
    NOTION_STATUS_PAGE_ID: z.string().optional().default(''),

    // ---------- Notion (이력) ----------
    NOTION_HISTORY_ENABLED: booleanish(false),
    NOTION_HISTORY_DATA_SOURCE_ID: z.string().optional().default(''),
    NOTION_HISTORY_INTERVAL_MINUTES: numberish(60, { min: 1, max: 10_080, int: true }),

    // ---------- 수집 ----------
    NAVER_JPY_URL: z
      .string()
      .optional()
      .transform((value) => (value && value.trim() !== '' ? value.trim() : DEFAULT_NAVER_URL))
      .pipe(z.string().url('올바른 URL 이어야 합니다')),
    SCRAPE_INTERVAL_SECONDS: numberish(60, { min: 10, max: 86_400, int: true }),
    REQUEST_TIMEOUT_MS: numberish(10_000, { min: 1_000, max: 120_000, int: true }),
    STALE_AFTER_MINUTES: numberish(5, { min: 1, max: 1_440, int: true }),
    FAILURE_ALERT_THRESHOLD: numberish(5, { min: 1, max: 1_000, int: true }),

    // ---------- 유효성 범위 ----------
    MIN_VALID_JPY100_KRW: numberish(100, { min: 0 }),
    MAX_VALID_JPY100_KRW: numberish(2_000, { min: 0 }),

    // ---------- 저장소 ----------
    SQLITE_PATH: z
      .string()
      .optional()
      .transform((value) =>
        value && value.trim() !== '' ? value.trim() : path.join('.', 'data', 'yenwatch.db'),
      ),
    DATA_RETENTION_DAYS: numberish(365, { min: 1, max: 36_500, int: true }),
  })
  .superRefine((value, ctx) => {
    if (value.MIN_VALID_JPY100_KRW >= value.MAX_VALID_JPY100_KRW) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MIN_VALID_JPY100_KRW'],
        message: 'MIN_VALID_JPY100_KRW 는 MAX_VALID_JPY100_KRW 보다 작아야 합니다',
      });
    }

    if (value.NOTION_ENABLED) {
      if (value.NOTION_TOKEN.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['NOTION_TOKEN'],
          message: 'NOTION_ENABLED=true 이면 NOTION_TOKEN 이 필요합니다',
        });
      }
      if (value.NOTION_DATA_SOURCE_ID.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['NOTION_DATA_SOURCE_ID'],
          message: 'NOTION_ENABLED=true 이면 NOTION_DATA_SOURCE_ID 가 필요합니다',
        });
      }
    }

    if (value.NOTION_HISTORY_ENABLED) {
      if (!value.NOTION_ENABLED) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['NOTION_HISTORY_ENABLED'],
          message: 'NOTION_HISTORY_ENABLED=true 이면 NOTION_ENABLED 도 true 여야 합니다',
        });
      }
      if (value.NOTION_HISTORY_DATA_SOURCE_ID.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['NOTION_HISTORY_DATA_SOURCE_ID'],
          message: 'NOTION_HISTORY_ENABLED=true 이면 NOTION_HISTORY_DATA_SOURCE_ID 가 필요합니다',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/** 검증 결과 (CLI 진단용). */
export type EnvValidation =
  | { readonly ok: true; readonly env: Env }
  | { readonly ok: false; readonly issues: readonly EnvIssue[] };

export interface EnvIssue {
  readonly key: string;
  readonly message: string;
}

let dotenvLoaded = false;

/** `.env` 를 프로세스 환경에 병합한다. 이미 존재하는 값은 덮어쓰지 않는다. */
export function loadDotenv(envFilePath = path.resolve(process.cwd(), '.env')): boolean {
  if (dotenvLoaded) return fs.existsSync(envFilePath);
  dotenvLoaded = true;
  if (!fs.existsSync(envFilePath)) return false;
  dotenv.config({ path: envFilePath, override: false });
  return true;
}

/** 프로세스를 종료하지 않고 환경변수를 검증한다. */
export function validateEnv(source: NodeJS.ProcessEnv = process.env): EnvValidation {
  const result = envSchema.safeParse(source);
  if (result.success) {
    return { ok: true, env: result.data };
  }
  const issues = result.error.issues.map((issue) => ({
    key: issue.path.length > 0 ? issue.path.join('.') : '(전체)',
    message: issue.message,
  }));
  return { ok: false, issues };
}

/** 검증 실패 메시지를 사람이 읽기 좋은 형태로 만든다. 값 자체는 절대 출력하지 않는다. */
export function formatEnvIssues(issues: readonly EnvIssue[]): string {
  const lines = [
    '환경변수 검증에 실패했습니다. `.env` 파일을 확인하세요.',
    '  (수정 도우미: npm run cli)',
    '',
  ];
  for (const issue of issues) {
    lines.push(`  ✗ ${issue.key}: ${issue.message}`);
  }
  lines.push('');
  lines.push('  예시 파일: .env.example');
  return lines.join('\n');
}

let cachedEnv: Env | null = null;

/**
 * 검증된 환경변수를 반환한다. 실패 시 ConfigError 를 던진다.
 * 최초 호출 시 `.env` 를 로드한다.
 */
export function loadEnv(options: { reload?: boolean } = {}): Env {
  if (cachedEnv && !options.reload) return cachedEnv;
  loadDotenv();
  const result = validateEnv();
  if (!result.ok) {
    throw new ConfigError(formatEnvIssues(result.issues));
  }
  cachedEnv = result.env;
  return cachedEnv;
}

/** 테스트에서 캐시를 비우기 위한 헬퍼. */
export function resetEnvCache(): void {
  cachedEnv = null;
  dotenvLoaded = false;
}

/** 로그/CLI 출력용 안전한 요약. 비밀값은 마스킹한다. */
export function summarizeEnv(env: Env): Record<string, string | number | boolean> {
  return {
    NODE_ENV: env.NODE_ENV,
    TZ: env.TZ,
    LOG_LEVEL: env.LOG_LEVEL,
    DISCORD_TOKEN: maskSecret(env.DISCORD_TOKEN),
    DISCORD_CLIENT_ID: env.DISCORD_CLIENT_ID,
    DISCORD_GUILD_ID: env.DISCORD_GUILD_ID,
    DISCORD_CHANNEL_ID: env.DISCORD_CHANNEL_ID,
    DISCORD_ALLOWED_USER_IDS: `${env.DISCORD_ALLOWED_USER_IDS.length}명`,
    NOTION_ENABLED: env.NOTION_ENABLED,
    NOTION_TOKEN: maskSecret(env.NOTION_TOKEN),
    NOTION_DATA_SOURCE_ID: maskId(env.NOTION_DATA_SOURCE_ID),
    NOTION_STATUS_PAGE_ID: maskId(env.NOTION_STATUS_PAGE_ID),
    NOTION_HISTORY_ENABLED: env.NOTION_HISTORY_ENABLED,
    NOTION_HISTORY_DATA_SOURCE_ID: maskId(env.NOTION_HISTORY_DATA_SOURCE_ID),
    NOTION_HISTORY_INTERVAL_MINUTES: env.NOTION_HISTORY_INTERVAL_MINUTES,
    NAVER_JPY_URL: env.NAVER_JPY_URL,
    SCRAPE_INTERVAL_SECONDS: env.SCRAPE_INTERVAL_SECONDS,
    REQUEST_TIMEOUT_MS: env.REQUEST_TIMEOUT_MS,
    STALE_AFTER_MINUTES: env.STALE_AFTER_MINUTES,
    FAILURE_ALERT_THRESHOLD: env.FAILURE_ALERT_THRESHOLD,
    MIN_VALID_JPY100_KRW: env.MIN_VALID_JPY100_KRW,
    MAX_VALID_JPY100_KRW: env.MAX_VALID_JPY100_KRW,
    SQLITE_PATH: env.SQLITE_PATH,
    DATA_RETENTION_DAYS: env.DATA_RETENTION_DAYS,
  };
}

/** 토큰류 마스킹: 앞 4자만 노출. */
export function maskSecret(value: string): string {
  if (!value) return '(미설정)';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}${'*'.repeat(8)}(${value.length}자)`;
}

/** ID 마스킹: 앞뒤 4자만 노출. */
export function maskId(value: string): string {
  if (!value) return '(미설정)';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
