import { describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  HttpFetchError,
  ParseError,
  RateValidationError,
  isRetryableError,
  toError,
} from '../src/errors.js';
import { DEFAULT_RETRY_DELAYS_MS, withRetry } from '../src/utils/retry.js';

/** 타이머를 실제로 기다리지 않고 대기 시간만 기록하는 sleep 대역. */
function recordingSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe('withRetry — 기본 정책', () => {
  it('첫 시도에 성공하면 재시도하지 않는다', async () => {
    const { delays, sleep } = recordingSleep();
    const operation = vi.fn(async () => 'ok');

    await expect(withRetry(operation, { sleep })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('요구사항대로 1초 / 3초 / 10초 간격으로 최대 3회 재시도한다', async () => {
    const { delays, sleep } = recordingSleep();
    const operation = vi.fn(async () => {
      throw new HttpFetchError('일시적 오류', { httpStatus: 503 });
    });

    await expect(withRetry(operation, { sleep })).rejects.toThrow('일시적 오류');
    // 최초 1회 + 재시도 3회 = 4회 호출
    expect(operation).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([1_000, 3_000, 10_000]);
    expect(DEFAULT_RETRY_DELAYS_MS).toEqual([1_000, 3_000, 10_000]);
  });

  it('중간에 성공하면 남은 재시도를 소비하지 않는다', async () => {
    const { delays, sleep } = recordingSleep();
    let attempts = 0;
    const operation = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new HttpFetchError('타임아웃', { httpStatus: null });
      return 946.32;
    });

    await expect(withRetry(operation, { sleep })).resolves.toBe(946.32);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1_000, 3_000]);
  });

  it('재시도 시 onRetry 콜백에 회차와 다음 대기 시간을 전달한다', async () => {
    const { sleep } = recordingSleep();
    const onRetry = vi.fn();
    const operation = vi.fn(async () => {
      throw new ParseError('일시적 파싱 실패');
    });

    await expect(withRetry(operation, { sleep, onRetry })).rejects.toThrow();
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1, delayMs: 1_000 });
    expect(onRetry.mock.calls[2]?.[0]).toMatchObject({ attempt: 3, delayMs: 10_000 });
  });
});

describe('withRetry — 재시도 가능 여부 분류', () => {
  it('HTTP 429 는 재시도한다', async () => {
    const { sleep } = recordingSleep();
    const operation = vi.fn(async () => {
      throw new HttpFetchError('rate limited', { httpStatus: 429 });
    });
    await expect(withRetry(operation, { sleep })).rejects.toThrow();
    expect(operation).toHaveBeenCalledTimes(4);
  });

  it('HTTP 5xx 는 재시도한다', async () => {
    const { sleep } = recordingSleep();
    const operation = vi.fn(async () => {
      throw new HttpFetchError('server error', { httpStatus: 502 });
    });
    await expect(withRetry(operation, { sleep })).rejects.toThrow();
    expect(operation).toHaveBeenCalledTimes(4);
  });

  it('HTTP 404 는 재시도하지 않는다', async () => {
    const { sleep } = recordingSleep();
    const operation = vi.fn(async () => {
      throw new HttpFetchError('not found', { httpStatus: 404 });
    });
    await expect(withRetry(operation, { sleep })).rejects.toThrow();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('유효성 범위 초과는 재시도하지 않는다', async () => {
    const { delays, sleep } = recordingSleep();
    const operation = vi.fn(async () => {
      throw new RateValidationError(88_897, 100, 2_000);
    });
    await expect(withRetry(operation, { sleep })).rejects.toBeInstanceOf(RateValidationError);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('설정 오류는 재시도하지 않는다', async () => {
    const { sleep } = recordingSleep();
    const operation = vi.fn(async () => {
      throw new ConfigError('DISCORD_TOKEN 없음');
    });
    await expect(withRetry(operation, { sleep })).rejects.toBeInstanceOf(ConfigError);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('네트워크 오류 코드는 재시도 대상으로 판정한다', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']) {
      const error = Object.assign(new Error('network'), { code });
      expect(isRetryableError(error)).toBe(true);
    }
  });

  it('abort 신호가 켜져 있으면 재시도를 시작하지 않는다', async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn(async () => 'ok');

    await expect(withRetry(operation, { signal: controller.signal })).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
  });
});

describe('toError', () => {
  it('Error 는 그대로 반환한다', () => {
    const error = new Error('boom');
    expect(toError(error)).toBe(error);
  });

  it('문자열을 Error 로 감싼다', () => {
    expect(toError('문제 발생').message).toBe('문제 발생');
  });

  it('객체도 안전하게 변환한다', () => {
    expect(toError({ code: 500 })).toBeInstanceOf(Error);
  });
});
