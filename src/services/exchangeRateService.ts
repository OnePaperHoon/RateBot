import { toError } from '../errors.js';
import { childLogger, LogEvent } from '../logger.js';
import type { HealthRepository } from '../database/healthRepository.js';
import type { RateRepository } from '../database/rateRepository.js';
import type { NaverJpyScraper } from '../scraper/naverJpyScraper.js';
import type {
  CollectionOutcome,
  CollectionTrigger,
  RangeStats,
  RateSnapshot,
} from '../types/exchangeRate.js';
import { calcChangeAmount, calcChangePercent, round2 } from '../utils/money.js';
import { Mutex } from '../utils/mutex.js';
import { DEFAULT_RETRY_DELAYS_MS, withRetry } from '../utils/retry.js';
import { nowIso } from '../utils/time.js';

const log = childLogger('exchange-rate');

/** `/yen-history` 에서 선택 가능한 기간. */
export const HISTORY_PERIODS = ['1h', '6h', '12h', '24h', '7d'] as const;
export type HistoryPeriod = (typeof HISTORY_PERIODS)[number];

const PERIOD_MINUTES: Record<HistoryPeriod, number> = {
  '1h': 60,
  '6h': 360,
  '12h': 720,
  '24h': 1_440,
  '7d': 10_080,
};

const PERIOD_LABELS: Record<HistoryPeriod, string> = {
  '1h': '최근 1시간',
  '6h': '최근 6시간',
  '12h': '최근 12시간',
  '24h': '최근 24시간',
  '7d': '최근 7일',
};

export interface ExchangeRateServiceDeps {
  readonly scraper: NaverJpyScraper;
  readonly rates: RateRepository;
  readonly health: HealthRepository;
  /**
   * 정기 스케줄과 `/yen-refresh` 가 공유하는 lock.
   * 주입받아 다른 서비스와 같은 인스턴스를 쓰도록 강제한다.
   */
  readonly mutex?: Mutex;
  readonly retryDelaysMs?: readonly number[];
}

/**
 * 환율 수집 오케스트레이션.
 *
 * 책임 경계:
 *  - 수집(스크레이퍼) + 재시도 + 계산 + SQLite 저장까지가 이 서비스의 책임이다.
 *  - Discord/Notion 전송은 notificationService 가 담당한다.
 *    (요구사항 20: SQLite 저장 성공 후 외부 서비스 갱신)
 */
export class ExchangeRateService {
  readonly #scraper: NaverJpyScraper;
  readonly #rates: RateRepository;
  readonly #health: HealthRepository;
  readonly #mutex: Mutex;
  readonly #retryDelaysMs: readonly number[];

  constructor(deps: ExchangeRateServiceDeps) {
    this.#scraper = deps.scraper;
    this.#rates = deps.rates;
    this.#health = deps.health;
    this.#mutex = deps.mutex ?? new Mutex();
    this.#retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  /** 정기 스케줄/수동 실행이 공유하는 lock. */
  get lock(): Mutex {
    return this.#mutex;
  }

  /** 현재 수집이 진행 중인가. */
  get isCollecting(): boolean {
    return this.#mutex.isLocked;
  }

  /**
   * 환율을 1회 수집한다.
   *
   * 이미 수집이 진행 중이면 **대기하지 않고 건너뛴다** (요구사항 6.4).
   * 어떤 경우에도 예외를 던지지 않고 CollectionOutcome 으로 결과를 표현한다.
   */
  async collect(trigger: CollectionTrigger, signal?: AbortSignal): Promise<CollectionOutcome> {
    const result = await this.#mutex.tryRun(() => this.#runCollection(trigger, signal));

    if (!result.ran) {
      const reason = '이전 수집 작업이 아직 진행 중입니다';
      log.warn(
        { event: LogEvent.RATE_COLLECTION_SKIPPED, trigger, heldForMs: this.#mutex.heldForMs },
        reason,
      );
      this.#health.record('scheduler', 'warn', `수집 건너뜀 (${trigger}): ${reason}`);
      return { status: 'skipped', reason };
    }

    return result.value;
  }

  async #runCollection(
    trigger: CollectionTrigger,
    signal?: AbortSignal,
  ): Promise<CollectionOutcome> {
    const startedAt = Date.now();
    log.debug({ event: LogEvent.RATE_COLLECTION_STARTED, trigger }, '환율 수집 시작');

    try {
      const scraped = await withRetry(() => this.#scraper.fetchRate(signal), {
        delaysMs: this.#retryDelaysMs,
        signal,
        onRetry: ({ attempt, delayMs, error }) => {
          log.warn(
            {
              event: 'rate_collection_retry',
              trigger,
              attempt,
              nextDelayMs: delayMs,
              reason: error.message,
            },
            '수집 재시도',
          );
        },
      });

      // 전회 대비 계산 — 저장 직전의 최신 행이 "전회" 다.
      const previous = this.#rates.findLatest();
      const changeAmount = calcChangeAmount(scraped.rate, previous?.rate ?? null);
      const changePercent = calcChangePercent(scraped.rate, previous?.rate ?? null);

      // SQLite 저장이 먼저 성공해야 외부 서비스로 나간다.
      const saved = this.#rates.insert({
        rate: scraped.rate,
        changeAmount,
        changePercent,
        collectedAt: scraped.collectedAt,
        source: scraped.source,
      });

      const extremes = this.#rates.dailyExtremes(saved.collectedAt);
      const snapshot: RateSnapshot = {
        rate: saved.rate,
        changeAmount: saved.changeAmount,
        changePercent: saved.changePercent,
        dailyHigh: extremes?.high ?? saved.rate,
        dailyLow: extremes?.low ?? saved.rate,
        collectedAt: saved.collectedAt,
        source: saved.source,
      };

      const durationMs = Date.now() - startedAt;
      log.info(
        {
          event: LogEvent.RATE_COLLECTED,
          rate: snapshot.rate,
          change: snapshot.changeAmount,
          changePercent: snapshot.changePercent,
          parser: scraped.parser,
          trigger,
          durationMs,
          collectedAt: snapshot.collectedAt,
        },
        '환율 수집 완료',
      );

      return { status: 'success', snapshot, durationMs };
    } catch (caught) {
      const error = toError(caught);
      const durationMs = Date.now() - startedAt;

      log.error(
        {
          event: LogEvent.RATE_COLLECTION_FAILED,
          trigger,
          durationMs,
          reason: error.message,
          errorType: error.name,
        },
        '환율 수집 실패 — 마지막 정상 데이터를 유지합니다',
      );
      this.#health.record('scraper', 'error', `${error.name}: ${error.message}`);

      return { status: 'failed', error, durationMs };
    }
  }

  /**
   * 저장된 마지막 정상 데이터로 스냅샷을 만든다.
   * 수집 실패 시에도 Discord/Notion 이 이 값을 계속 표시한다.
   */
  getLastKnownSnapshot(): RateSnapshot | null {
    const latest = this.#rates.findLatest();
    if (!latest) return null;

    const extremes = this.#rates.dailyExtremes(latest.collectedAt);
    return {
      rate: latest.rate,
      changeAmount: latest.changeAmount,
      changePercent: latest.changePercent,
      dailyHigh: extremes?.high ?? latest.rate,
      dailyLow: extremes?.low ?? latest.rate,
      collectedAt: latest.collectedAt,
      source: latest.source,
    };
  }

  /** `/yen-history` 용 기간 통계. 데이터가 없으면 null. */
  getRangeStats(period: HistoryPeriod, now: Date = new Date()): RangeStats | null {
    const minutes = PERIOD_MINUTES[period];
    const startIso = new Date(now.getTime() - minutes * 60_000).toISOString();
    const endIso = now.toISOString();

    const records = this.#rates.findBetween(startIso, endIso);
    if (records.length === 0) return null;

    const first = records[0];
    const last = records[records.length - 1];
    if (!first || !last) return null;

    const series = records.map((record) => record.rate);
    const high = Math.max(...series);
    const low = Math.min(...series);
    const changeAmount = calcChangeAmount(last.rate, first.rate) ?? 0;
    const changePercent = calcChangePercent(last.rate, first.rate) ?? 0;

    return {
      periodLabel: PERIOD_LABELS[period],
      openRate: first.rate,
      closeRate: last.rate,
      high: round2(high),
      low: round2(low),
      changeAmount,
      changePercent,
      dataPoints: records.length,
      series,
      firstAt: first.collectedAt,
      lastAt: last.collectedAt,
    };
  }

  /** 저장된 전체 환율 건수. */
  countRecords(): number {
    return this.#rates.count();
  }

  /** 마지막 수집 이후 경과 시간(ms). 데이터가 없으면 null. */
  msSinceLastRecord(now: Date = new Date()): number | null {
    const latest = this.#rates.findLatest();
    if (!latest) return null;
    const collected = new Date(latest.collectedAt).getTime();
    if (Number.isNaN(collected)) return null;
    return now.getTime() - collected;
  }

  /** 진행 중인 수집이 끝날 때까지 대기 (graceful shutdown). */
  async waitForIdle(timeoutMs: number): Promise<boolean> {
    return this.#mutex.waitForIdle(timeoutMs);
  }

  /** 현재 시각 ISO (테스트에서 시간 흐름 확인용). */
  static now(): string {
    return nowIso();
  }
}
