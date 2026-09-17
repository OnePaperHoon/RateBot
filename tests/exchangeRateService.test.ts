import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import iconv from 'iconv-lite';
import type { Database as SqliteDatabase } from 'better-sqlite3';

import { closeDatabase, openDatabase } from '../src/database/client.js';
import { HealthRepository } from '../src/database/healthRepository.js';
import { RateRepository } from '../src/database/rateRepository.js';
import { NaverJpyScraper } from '../src/scraper/naverJpyScraper.js';
import { ExchangeRateService } from '../src/services/exchangeRateService.js';
import { RateValidationError } from '../src/errors.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const URL = 'https://finance.naver.com/marketindex/exchangeDetail.naver?marketindexCd=FX_JPYKRW';

function fixtureBuffer(name: string): Buffer {
  // 네이버는 EUC-KR 로 응답하므로 fixture 도 같은 인코딩의 바이트로 만든다.
  return iconv.encode(fs.readFileSync(path.join(FIXTURES, name), 'utf8'), 'euc-kr');
}

/** 지정한 응답을 돌려주는 최소 axios 대역. */
function stubHttpClient(responses: {
  status?: number;
  body?: Buffer;
  contentType?: string;
  throws?: Error;
}): { client: AxiosInstance; calls: number } {
  const state = { calls: 0 };
  const client = {
    get: async () => {
      state.calls += 1;
      if (responses.throws) throw responses.throws;
      return {
        data: responses.body ?? Buffer.alloc(0),
        status: responses.status ?? 200,
        headers: { 'content-type': responses.contentType ?? 'text/html;charset=EUC-KR' },
      };
    },
  } as unknown as AxiosInstance;

  return {
    client,
    get calls() {
      return state.calls;
    },
  };
}

function createScraper(httpClient: AxiosInstance): NaverJpyScraper {
  // 이 파일은 서비스의 재시도/저장 로직을 검증한다. 스크레이퍼 경로 선택(JSON API 우선,
  // HTML 폴백)은 naverJpyScraper.test.ts 가 다루므로 여기서는 HTML 경로만 쓴다.
  return new NaverJpyScraper(
    { url: URL, apiUrl: null, timeoutMs: 10_000, minValid: 100, maxValid: 2_000 },
    { httpClient },
  );
}

describe('ExchangeRateService — 정상 수집', () => {
  let db: SqliteDatabase;
  let rates: RateRepository;
  let service: ExchangeRateService;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    rates = new RateRepository(db);
    const stub = stubHttpClient({ body: fixtureBuffer('naver-jpy-sample.html') });
    service = new ExchangeRateService({
      scraper: createScraper(stub.client),
      rates,
      health: new HealthRepository(db),
      retryDelaysMs: [],
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('수집 결과를 SQLite 에 저장하고 스냅샷을 만든다', async () => {
    const outcome = await service.collect('startup');

    expect(outcome.status).toBe('success');
    if (outcome.status !== 'success') return;

    expect(outcome.snapshot.rate).toBe(888.97);
    expect(outcome.snapshot.source).toBe(URL);
    expect(rates.count()).toBe(1);
  });

  it('첫 수집은 비교 대상이 없으므로 변화량이 null 이다', async () => {
    const outcome = await service.collect('startup');
    expect(outcome.status).toBe('success');
    if (outcome.status !== 'success') return;

    expect(outcome.snapshot.changeAmount).toBeNull();
    expect(outcome.snapshot.changePercent).toBeNull();
  });

  it('두 번째 수집부터 전회 대비를 계산한다', async () => {
    // 직전 값을 직접 넣어 비교 대상을 만든다.
    rates.insert({
      rate: 885.0,
      changeAmount: null,
      changePercent: null,
      collectedAt: new Date(Date.now() - 60_000).toISOString(),
      source: URL,
    });

    const outcome = await service.collect('schedule');
    expect(outcome.status).toBe('success');
    if (outcome.status !== 'success') return;

    expect(outcome.snapshot.changeAmount).toBe(3.97);
    expect(outcome.snapshot.changePercent).toBe(0.45);
  });

  it('당일 최고/최저가 스냅샷에 포함된다', async () => {
    const now = new Date();
    rates.insert({
      rate: 880.0,
      changeAmount: null,
      changePercent: null,
      collectedAt: new Date(now.getTime() - 120_000).toISOString(),
      source: URL,
    });
    rates.insert({
      rate: 895.0,
      changeAmount: null,
      changePercent: null,
      collectedAt: new Date(now.getTime() - 60_000).toISOString(),
      source: URL,
    });

    const outcome = await service.collect('schedule');
    expect(outcome.status).toBe('success');
    if (outcome.status !== 'success') return;

    expect(outcome.snapshot.dailyHigh).toBe(895.0);
    expect(outcome.snapshot.dailyLow).toBe(880.0);
  });

  it('마지막 정상 데이터를 다시 조회할 수 있다', async () => {
    await service.collect('startup');
    const lastKnown = service.getLastKnownSnapshot();
    expect(lastKnown?.rate).toBe(888.97);
  });
});

describe('ExchangeRateService — 실패 처리', () => {
  let db: SqliteDatabase;
  let rates: RateRepository;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    rates = new RateRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function serviceWith(stub: ReturnType<typeof stubHttpClient>): ExchangeRateService {
    return new ExchangeRateService({
      scraper: createScraper(stub.client),
      rates,
      health: new HealthRepository(db),
      retryDelaysMs: [],
    });
  }

  it('파싱 실패는 예외를 던지지 않고 failed 결과를 반환한다', async () => {
    const service = serviceWith(stubHttpClient({ body: fixtureBuffer('naver-jpy-broken.html') }));
    const outcome = await service.collect('schedule');
    expect(outcome.status).toBe('failed');
  });

  /** 요구사항 6.2: 실패한 값을 rates 테이블에 저장하지 않는다 */
  it('실패 시 rates 테이블에 아무것도 저장하지 않는다', async () => {
    const service = serviceWith(stubHttpClient({ body: fixtureBuffer('naver-jpy-broken.html') }));
    await service.collect('schedule');
    expect(rates.count()).toBe(0);
  });

  /** 요구사항 2: 파싱된 값이 비정상이면 저장하거나 전송하지 않는다 */
  it('유효 범위를 벗어난 값은 거부하고 저장하지 않는다', async () => {
    const service = serviceWith(
      stubHttpClient({ body: fixtureBuffer('naver-jpy-out-of-range.html') }),
    );
    const outcome = await service.collect('schedule');

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.error).toBeInstanceOf(RateValidationError);
    expect(rates.count()).toBe(0);
  });

  it('HTTP 500 응답도 failed 로 처리한다', async () => {
    const service = serviceWith(stubHttpClient({ status: 500, body: Buffer.from('error') }));
    const outcome = await service.collect('schedule');
    expect(outcome.status).toBe('failed');
    expect(rates.count()).toBe(0);
  });

  it('실패해도 마지막 정상 데이터는 그대로 유지된다', async () => {
    rates.insert({
      rate: 946.32,
      changeAmount: null,
      changePercent: null,
      collectedAt: new Date().toISOString(),
      source: URL,
    });

    const service = serviceWith(stubHttpClient({ body: fixtureBuffer('naver-jpy-broken.html') }));
    await service.collect('schedule');

    expect(service.getLastKnownSnapshot()?.rate).toBe(946.32);
    expect(rates.count()).toBe(1);
  });

  it('네트워크 예외도 failed 로 흡수한다 (프로세스를 죽이지 않는다)', async () => {
    const service = serviceWith(
      stubHttpClient({
        throws: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      }),
    );
    const outcome = await service.collect('schedule');
    expect(outcome.status).toBe('failed');
  });
});

describe('ExchangeRateService — 중복 실행 방지', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('수집이 진행 중이면 두 번째 호출을 건너뛴다', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const body = fixtureBuffer('naver-jpy-sample.html');
    const slowClient = {
      get: async () => {
        await gate;
        return {
          data: body,
          status: 200,
          headers: { 'content-type': 'text/html;charset=EUC-KR' },
        };
      },
    } as unknown as AxiosInstance;

    const service = new ExchangeRateService({
      scraper: createScraper(slowClient),
      rates: new RateRepository(db),
      health: new HealthRepository(db),
      retryDelaysMs: [],
    });

    const first = service.collect('schedule');
    // 정기 스케줄이 도착했지만 이전 작업이 아직 진행 중
    const second = await service.collect('schedule');
    // /yen-refresh 도 같은 lock 을 공유한다
    const manual = await service.collect('manual');

    expect(second.status).toBe('skipped');
    expect(manual.status).toBe('skipped');
    expect(service.isCollecting).toBe(true);

    release();
    expect((await first).status).toBe('success');
    expect(service.isCollecting).toBe(false);
  });

  it('건너뛴 결과에는 사유가 담긴다', async () => {
    const stub = stubHttpClient({ body: fixtureBuffer('naver-jpy-sample.html') });
    const service = new ExchangeRateService({
      scraper: createScraper(stub.client),
      rates: new RateRepository(db),
      health: new HealthRepository(db),
      retryDelaysMs: [],
    });

    const running = service.collect('schedule');
    const skipped = await service.collect('schedule');

    expect(skipped.status).toBe('skipped');
    if (skipped.status !== 'skipped') return;
    expect(skipped.reason).toContain('진행 중');

    await running;
  });
});

describe('ExchangeRateService — 재시도 통합', () => {
  it('일시적 실패 후 성공하면 저장된다', async () => {
    const db = openDatabase({ filePath: ':memory:' });
    const rates = new RateRepository(db);

    let attempt = 0;
    const body = fixtureBuffer('naver-jpy-sample.html');
    const flakyClient = {
      get: async () => {
        attempt += 1;
        if (attempt < 3) {
          return { data: Buffer.from(''), status: 503, headers: { 'content-type': 'text/html' } };
        }
        return { data: body, status: 200, headers: { 'content-type': 'text/html;charset=EUC-KR' } };
      },
    } as unknown as AxiosInstance;

    const service = new ExchangeRateService({
      scraper: createScraper(flakyClient),
      rates,
      health: new HealthRepository(db),
      retryDelaysMs: [0, 0, 0], // 테스트에서는 대기 없이
    });

    const outcome = await service.collect('schedule');
    expect(outcome.status).toBe('success');
    expect(attempt).toBe(3);
    expect(rates.count()).toBe(1);

    closeDatabase(db);
  });

  it('유효성 오류는 재시도하지 않는다 (요청이 1회만 나간다)', async () => {
    const db = openDatabase({ filePath: ':memory:' });
    const get = vi.fn(async () => ({
      data: fixtureBuffer('naver-jpy-out-of-range.html'),
      status: 200,
      headers: { 'content-type': 'text/html;charset=EUC-KR' },
    }));
    const client = { get } as unknown as AxiosInstance;

    const service = new ExchangeRateService({
      scraper: createScraper(client),
      rates: new RateRepository(db),
      health: new HealthRepository(db),
      retryDelaysMs: [0, 0, 0],
    });

    await service.collect('schedule');
    expect(get).toHaveBeenCalledTimes(1);

    closeDatabase(db);
  });
});

describe('ExchangeRateService — 기간 통계', () => {
  let db: SqliteDatabase;
  let service: ExchangeRateService;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    const rates = new RateRepository(db);
    const now = Date.now();

    // 최근 3시간, 30분 간격
    const samples = [940.0, 942.5, 949.1, 938.2, 946.32, 947.0];
    samples.forEach((rate, index) => {
      rates.insert({
        rate,
        changeAmount: null,
        changePercent: null,
        collectedAt: new Date(now - (samples.length - index) * 30 * 60_000).toISOString(),
        source: URL,
      });
    });

    const stub = stubHttpClient({ body: fixtureBuffer('naver-jpy-sample.html') });
    service = new ExchangeRateService({
      scraper: createScraper(stub.client),
      rates,
      health: new HealthRepository(db),
      retryDelaysMs: [],
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('24시간 통계를 계산한다', () => {
    const stats = service.getRangeStats('24h');
    expect(stats).not.toBeNull();
    if (!stats) return;

    expect(stats.dataPoints).toBe(6);
    expect(stats.openRate).toBe(940.0);
    expect(stats.closeRate).toBe(947.0);
    expect(stats.high).toBe(949.1);
    expect(stats.low).toBe(938.2);
    expect(stats.changeAmount).toBe(7.0);
    expect(stats.series).toHaveLength(6);
  });

  it('1시간 통계는 최근 데이터만 포함한다', () => {
    const stats = service.getRangeStats('1h');
    expect(stats?.dataPoints).toBeLessThanOrEqual(3);
  });

  it('데이터가 없는 기간은 null 을 반환한다', () => {
    const emptyDb = openDatabase({ filePath: ':memory:' });
    const stub = stubHttpClient({ body: Buffer.alloc(0) });
    const emptyService = new ExchangeRateService({
      scraper: createScraper(stub.client),
      rates: new RateRepository(emptyDb),
      health: new HealthRepository(emptyDb),
    });

    expect(emptyService.getRangeStats('7d')).toBeNull();
    closeDatabase(emptyDb);
  });
});
