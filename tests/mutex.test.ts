import { describe, expect, it, vi } from 'vitest';
import { Mutex } from '../src/utils/mutex.js';

/** 수동으로 완료시킬 수 있는 Promise. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Mutex — 중복 실행 방지', () => {
  it('잠겨 있지 않으면 작업을 실행한다', async () => {
    const mutex = new Mutex();
    const result = await mutex.tryRun(async () => 42);
    expect(result).toEqual({ ran: true, value: 42 });
  });

  /** 요구사항 6.4: 이전 수집이 끝나기 전에 다음 스케줄이 오면 **건너뛴다** (대기하지 않는다) */
  it('실행 중이면 대기하지 않고 건너뛴다', async () => {
    const mutex = new Mutex();
    const gate = deferred<void>();
    const second = vi.fn(async () => 'second');

    const firstPromise = mutex.tryRun(async () => {
      await gate.promise;
      return 'first';
    });

    // 첫 작업이 끝나기 전에 두 번째 시도
    const secondResult = await mutex.tryRun(second);
    expect(secondResult).toEqual({ ran: false });
    expect(second).not.toHaveBeenCalled();

    gate.resolve();
    expect(await firstPromise).toEqual({ ran: true, value: 'first' });
  });

  it('작업이 끝나면 다시 실행할 수 있다', async () => {
    const mutex = new Mutex();
    await mutex.tryRun(async () => 'first');
    const result = await mutex.tryRun(async () => 'second');
    expect(result).toEqual({ ran: true, value: 'second' });
  });

  it('작업이 예외를 던져도 lock 이 해제된다', async () => {
    const mutex = new Mutex();

    await expect(
      mutex.tryRun(async () => {
        throw new Error('실패');
      }),
    ).rejects.toThrow('실패');

    expect(mutex.isLocked).toBe(false);
    expect(await mutex.tryRun(async () => 'ok')).toEqual({ ran: true, value: 'ok' });
  });

  it('isLocked 로 진행 여부를 알 수 있다', async () => {
    const mutex = new Mutex();
    const gate = deferred<void>();

    expect(mutex.isLocked).toBe(false);
    const running = mutex.tryRun(async () => {
      await gate.promise;
    });
    expect(mutex.isLocked).toBe(true);
    expect(mutex.heldForMs).toBeGreaterThanOrEqual(0);

    gate.resolve();
    await running;
    expect(mutex.isLocked).toBe(false);
    expect(mutex.heldForMs).toBeNull();
  });

  it('동시에 여러 번 시도해도 한 번만 실행된다', async () => {
    const mutex = new Mutex();
    const gate = deferred<void>();
    const task = vi.fn(async () => {
      await gate.promise;
      return 'done';
    });

    const attempts = [
      mutex.tryRun(task),
      mutex.tryRun(task),
      mutex.tryRun(task),
      mutex.tryRun(task),
      mutex.tryRun(task),
    ];

    gate.resolve();
    const results = await Promise.all(attempts);

    expect(task).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.ran)).toHaveLength(1);
    expect(results.filter((result) => !result.ran)).toHaveLength(4);
  });
});

describe('Mutex — 종료 시 대기', () => {
  it('잠겨 있지 않으면 즉시 반환한다', async () => {
    const mutex = new Mutex();
    await expect(mutex.waitForIdle(1_000)).resolves.toBe(true);
  });

  it('진행 중인 작업이 끝날 때까지 기다린다', async () => {
    const mutex = new Mutex();
    const gate = deferred<void>();

    const running = mutex.tryRun(async () => {
      await gate.promise;
    });

    let finished = false;
    const waiter = mutex.waitForIdle(5_000).then((result) => {
      finished = true;
      return result;
    });

    expect(finished).toBe(false);
    gate.resolve();
    await running;

    await expect(waiter).resolves.toBe(true);
    expect(finished).toBe(true);
  });

  it('제한 시간을 넘기면 false 를 반환한다', async () => {
    const mutex = new Mutex();
    const gate = deferred<void>();
    const running = mutex.tryRun(async () => {
      await gate.promise;
    });

    await expect(mutex.waitForIdle(20)).resolves.toBe(false);

    gate.resolve();
    await running;
  });
});
