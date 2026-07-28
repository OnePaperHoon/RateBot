/**
 * 애플리케이션 전용 에러 타입.
 *
 * `retryable` 플래그로 재시도 정책(utils/retry.ts)을 결정한다.
 *  - 재시도 O: 네트워크 오류, 타임아웃, HTTP 429/5xx, 일시적 파싱 실패
 *  - 재시도 X: 환경변수 오류, Discord 권한 오류, Notion 스키마 오류, 유효성 범위 초과
 */

export abstract class YenWatchError extends Error {
  /** 이 오류로 인해 같은 작업을 다시 시도해도 되는가. */
  abstract readonly retryable: boolean;
  /** 로그 이벤트 분류용 코드. */
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
    Error.captureStackTrace?.(this, new.target);
  }
}

/** 환경변수 / 설정 오류. 프로세스를 시작하면 안 된다. */
export class ConfigError extends YenWatchError {
  override readonly retryable = false;
  override readonly code = 'config_error';
}

/** HTTP 요청 실패 (네트워크/타임아웃/5xx/429). */
export class HttpFetchError extends YenWatchError {
  override readonly code = 'http_fetch_error';
  override readonly retryable: boolean;
  readonly httpStatus: number | null;

  constructor(
    message: string,
    params: { httpStatus?: number | null; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: params.cause });
    this.httpStatus = params.httpStatus ?? null;
    // 4xx(429 제외)는 구조 변경/차단이므로 재시도해도 동일하다.
    this.retryable =
      params.retryable ??
      (this.httpStatus === null ||
        this.httpStatus === 429 ||
        this.httpStatus >= 500 ||
        this.httpStatus === 408);
  }
}

/** HTML 파싱 실패. 일시적 오류일 수 있으므로 기본은 재시도 가능. */
export class ParseError extends YenWatchError {
  override readonly code = 'parse_error';
  override readonly retryable: boolean;
  /** 시도한 파서와 실패 사유 (전체 HTML 은 포함하지 않는다). */
  readonly attempts: readonly string[];

  constructor(
    message: string,
    params: { attempts?: readonly string[]; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: params.cause });
    this.attempts = params.attempts ?? [];
    this.retryable = params.retryable ?? true;
  }
}

/** 파싱은 됐지만 값이 허용 범위를 벗어남. 재시도해도 소용없다. */
export class RateValidationError extends YenWatchError {
  override readonly retryable = false;
  override readonly code = 'rate_validation_error';
  readonly value: number;
  readonly min: number;
  readonly max: number;

  constructor(value: number, min: number, max: number) {
    super(
      `파싱된 환율 ${value} 가 허용 범위를 벗어났습니다 (허용: ${min} ~ ${max} KRW / 100 JPY).`,
    );
    this.value = value;
    this.min = min;
    this.max = max;
  }
}

/** Notion 데이터 소스 스키마 불일치. 사용자가 Notion 을 고쳐야 한다. */
export class NotionSchemaError extends YenWatchError {
  override readonly retryable = false;
  override readonly code = 'notion_schema_error';
  readonly report: string;

  constructor(message: string, report: string) {
    super(message);
    this.report = report;
  }
}

/** Discord 권한/설정 오류. */
export class DiscordConfigError extends YenWatchError {
  override readonly retryable = false;
  override readonly code = 'discord_config_error';
}

/** 알 수 없는 값을 Error 로 정규화한다. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

/** 재시도 가능 여부 판정. 알 수 없는 오류는 보수적으로 재시도 가능으로 본다. */
export function isRetryableError(value: unknown): boolean {
  if (value instanceof YenWatchError) return value.retryable;
  if (value instanceof Error) {
    // axios / undici 등의 저수준 네트워크 오류 코드
    const code = (value as NodeJS.ErrnoException).code;
    if (
      code === 'ECONNRESET' ||
      code === 'ECONNABORTED' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN' ||
      code === 'EPIPE' ||
      code === 'ECONNREFUSED'
    ) {
      return true;
    }
  }
  return true;
}
