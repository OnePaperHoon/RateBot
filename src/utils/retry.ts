import { isRetryableError, toError } from '../errors.js';

/**
 * 고정 백오프 재시도.
 *
 * 기본 정책(요구사항 6.1): 최대 3회 재시도, 간격 1초 / 3초 / 10초.
 * 재시도 불가 오류(설정 오류, 유효성 범위 초과 등)는 즉시 던진다.
 */

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 10_000];

export interface RetryContext {
  /** 1부터 시작하는 시도 회차 (1 = 최초 시도). */
  readonly attempt: number;
  /** 다음 시도까지 대기할 밀리초. */
  readonly delayMs: number;
  readonly error: Error;
}

export interface RetryOptions {
  /** 재시도 간격 배열. 길이가 곧 최대 재시도 횟수. */
  readonly delaysMs?: readonly number[];
  /** 이 오류를 재시도해도 되는가. 기본은 errors.ts 의 판정. */
  readonly isRetryable?: (error: unknown) => boolean;
  /** 재시도 직전 콜백 (로깅용). */
  readonly onRetry?: (context: RetryContext) => void;
  /** 대기 구현 주입 (테스트에서 타이머를 없애기 위함). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 취소 신호. abort 되면 대기를 중단하고 마지막 오류를 던진다. */
  readonly signal?: AbortSignal;
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // 대기 중 프로세스가 종료되지 못하는 것을 방지
    timer.unref?.();
  });
}

/**
 * `operation` 을 성공할 때까지 재시도한다.
 * 모든 시도가 실패하면 마지막 오류를 던진다.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const delays = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const canRetry = options.isRetryable ?? isRetryableError;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = delays.length + 1;

  let lastError: Error = new Error('재시도가 한 번도 실행되지 않았습니다');

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw lastError;
    }
    try {
      return await operation(attempt);
    } catch (caught) {
      lastError = toError(caught);

      const isLastAttempt = attempt === maxAttempts;
      if (isLastAttempt || !canRetry(caught)) {
        throw lastError;
      }

      const delayMs = delays[attempt - 1] ?? delays[delays.length - 1] ?? 1_000;
      options.onRetry?.({ attempt, delayMs, error: lastError });
      await sleep(delayMs);
    }
  }

  throw lastError;
}
