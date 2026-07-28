/**
 * 단순 비동기 뮤텍스.
 *
 * 요구사항 6.4:
 *  - 정기 스케줄과 `/yen-refresh` 가 같은 lock 을 공유한다.
 *  - 이전 작업이 끝나기 전에 다음 스케줄이 오면 **대기하지 않고 건너뛴다**
 *    -> `tryRun()` 사용
 *  - 종료 시에는 진행 중인 작업이 끝나기를 기다린다 -> `waitForIdle()`
 */

export interface TryRunSkipped {
  readonly ran: false;
}

export interface TryRunExecuted<T> {
  readonly ran: true;
  readonly value: T;
}

export type TryRunResult<T> = TryRunExecuted<T> | TryRunSkipped;

export class Mutex {
  #locked = false;
  #waiters: Array<() => void> = [];
  #lockedAt: number | null = null;

  /** 현재 잠겨 있는가 (= 작업이 진행 중인가). */
  get isLocked(): boolean {
    return this.#locked;
  }

  /** 잠긴 뒤 경과한 밀리초. 잠겨 있지 않으면 null. */
  get heldForMs(): number | null {
    return this.#lockedAt === null ? null : Date.now() - this.#lockedAt;
  }

  /**
   * 잠금을 획득할 수 있으면 실행하고, 이미 실행 중이면 건너뛴다.
   * 반환값의 `ran` 으로 실행 여부를 구분한다.
   */
  async tryRun<T>(task: () => Promise<T>): Promise<TryRunResult<T>> {
    if (this.#locked) {
      return { ran: false };
    }
    this.#locked = true;
    this.#lockedAt = Date.now();
    try {
      const value = await task();
      return { ran: true, value };
    } finally {
      this.#release();
    }
  }

  /** 진행 중인 작업이 끝날 때까지 대기한다. 잠겨 있지 않으면 즉시 반환. */
  async waitForIdle(timeoutMs?: number): Promise<boolean> {
    if (!this.#locked) return true;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const waiter = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(true);
      };

      this.#waiters.push(waiter);

      if (timeoutMs !== undefined && timeoutMs >= 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          resolve(false);
        }, timeoutMs);
        timer.unref?.();
      }
    });
  }

  #release(): void {
    this.#locked = false;
    this.#lockedAt = null;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter();
  }
}
