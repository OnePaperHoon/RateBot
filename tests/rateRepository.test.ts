import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { closeDatabase, openDatabase } from '../src/database/client.js';
import { currentVersion, targetVersion } from '../src/database/migrations.js';
import { RateRepository } from '../src/database/rateRepository.js';
import { SettingKey, SettingsRepository } from '../src/database/settingsRepository.js';
import { HealthRepository } from '../src/database/healthRepository.js';
import { seoulDayBoundsUtc, seoulDayKey } from '../src/utils/time.js';

const SOURCE = 'https://finance.naver.com/marketindex/exchangeDetail.naver?marketindexCd=FX_JPYKRW';

describe('SQLite 저장 및 조회', () => {
  let db: SqliteDatabase;
  let rates: RateRepository;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    rates = new RateRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('마이그레이션이 최신 버전까지 적용된다', () => {
    expect(currentVersion(db)).toBe(targetVersion());
  });

  it('환율을 저장하고 다시 읽어온다', () => {
    const saved = rates.insert({
      rate: 946.32,
      changeAmount: 1.24,
      changePercent: 0.13,
      collectedAt: '2026-07-29T14:45:00.000Z',
      source: SOURCE,
    });

    expect(saved.id).toBeGreaterThan(0);

    const latest = rates.findLatest();
    expect(latest).toMatchObject({
      rate: 946.32,
      changeAmount: 1.24,
      changePercent: 0.13,
      collectedAt: '2026-07-29T14:45:00.000Z',
      source: SOURCE,
    });
  });

  it('소수점 셋째 자리 이하는 둘째 자리로 반올림해 저장한다', () => {
    const saved = rates.insert({
      rate: 946.3249,
      changeAmount: 1.2351,
      changePercent: null,
      collectedAt: '2026-07-29T14:45:00.000Z',
      source: SOURCE,
    });
    expect(saved.rate).toBe(946.32);
    expect(saved.changeAmount).toBe(1.24);
    expect(rates.findLatest()?.rate).toBe(946.32);
  });

  it('데이터가 없으면 findLatest 는 null 을 반환한다', () => {
    expect(rates.findLatest()).toBeNull();
    expect(rates.count()).toBe(0);
  });

  it('직전 레코드를 찾아 전회 대비 계산에 쓸 수 있다', () => {
    const first = rates.insert({
      rate: 945.08,
      changeAmount: null,
      changePercent: null,
      collectedAt: '2026-07-29T14:44:00.000Z',
      source: SOURCE,
    });
    const second = rates.insert({
      rate: 946.32,
      changeAmount: 1.24,
      changePercent: 0.13,
      collectedAt: '2026-07-29T14:45:00.000Z',
      source: SOURCE,
    });

    expect(rates.findPrevious(second.id)?.id).toBe(first.id);
    expect(rates.findPrevious(first.id)).toBeNull();
  });
});

describe('기간 조회', () => {
  let db: SqliteDatabase;
  let rates: RateRepository;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    rates = new RateRepository(db);

    // 2026-07-29 KST 오전 9시부터 1시간 간격 5건
    const samples: Array<[string, number]> = [
      ['2026-07-29T00:00:00.000Z', 940.0], // KST 09:00
      ['2026-07-29T01:00:00.000Z', 943.5], // KST 10:00
      ['2026-07-29T02:00:00.000Z', 949.1], // KST 11:00  <- 당일 최고
      ['2026-07-29T03:00:00.000Z', 938.2], // KST 12:00  <- 당일 최저
      ['2026-07-29T04:00:00.000Z', 946.32], // KST 13:00
    ];
    for (const [collectedAt, rate] of samples) {
      rates.insert({ rate, changeAmount: null, changePercent: null, collectedAt, source: SOURCE });
    }
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('구간 조회는 오름차순으로 반환한다', () => {
    const records = rates.findBetween('2026-07-29T00:00:00.000Z', '2026-07-29T04:00:00.000Z');
    expect(records).toHaveLength(5);
    expect(records.map((record) => record.rate)).toEqual([940.0, 943.5, 949.1, 938.2, 946.32]);
  });

  it('구간 경계 밖의 데이터는 제외한다', () => {
    const records = rates.findBetween('2026-07-29T01:00:00.000Z', '2026-07-29T03:00:00.000Z');
    expect(records).toHaveLength(3);
  });

  it('구간 집계로 최고/최저/개수를 얻는다', () => {
    const aggregate = rates.aggregateBetween(
      '2026-07-29T00:00:00.000Z',
      '2026-07-29T04:00:00.000Z',
    );
    expect(aggregate).toEqual({ high: 949.1, low: 938.2, count: 5 });
  });

  it('데이터가 없는 구간은 count 0 을 반환한다', () => {
    const aggregate = rates.aggregateBetween(
      '2020-01-01T00:00:00.000Z',
      '2020-01-02T00:00:00.000Z',
    );
    expect(aggregate.count).toBe(0);
  });

  it('기간 시작 환율을 찾는다', () => {
    expect(rates.findFirstSince('2026-07-29T02:00:00.000Z')?.rate).toBe(949.1);
  });
});

describe('당일 최고/최저 (Asia/Seoul 기준)', () => {
  let db: SqliteDatabase;
  let rates: RateRepository;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    rates = new RateRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('같은 KST 날짜의 데이터로 고가/저가를 계산한다', () => {
    // 모두 2026-07-29 KST
    for (const [collectedAt, rate] of [
      ['2026-07-28T15:30:00.000Z', 942.8], // KST 07-29 00:30
      ['2026-07-29T05:00:00.000Z', 949.1], // KST 07-29 14:00
      ['2026-07-29T14:59:00.000Z', 946.32], // KST 07-29 23:59
    ] as Array<[string, number]>) {
      rates.insert({ rate, changeAmount: null, changePercent: null, collectedAt, source: SOURCE });
    }

    const extremes = rates.dailyExtremes('2026-07-29T14:59:00.000Z');
    expect(extremes).toEqual({ high: 949.1, low: 942.8, count: 3, dayKey: '2026-07-29' });
  });

  /**
   * 요구사항 16.12 — 날짜가 바뀌면 일일 범위가 초기화되어야 한다.
   * KST 자정(= UTC 15:00)을 경계로 전날 데이터가 섞이면 안 된다.
   */
  it('KST 자정을 넘기면 당일 범위가 새로 시작된다', () => {
    // 07-29 KST 데이터
    rates.insert({
      rate: 900.0,
      changeAmount: null,
      changePercent: null,
      collectedAt: '2026-07-29T14:58:00.000Z', // KST 07-29 23:58
      source: SOURCE,
    });
    // 07-30 KST 데이터 (2분 뒤지만 날짜가 바뀜)
    rates.insert({
      rate: 1_000.0,
      changeAmount: null,
      changePercent: null,
      collectedAt: '2026-07-29T15:00:00.000Z', // KST 07-30 00:00
      source: SOURCE,
    });
    rates.insert({
      rate: 1_010.0,
      changeAmount: null,
      changePercent: null,
      collectedAt: '2026-07-29T15:01:00.000Z', // KST 07-30 00:01
      source: SOURCE,
    });

    const day29 = rates.dailyExtremes('2026-07-29T14:58:00.000Z');
    expect(day29).toEqual({ high: 900.0, low: 900.0, count: 1, dayKey: '2026-07-29' });

    const day30 = rates.dailyExtremes('2026-07-29T15:01:00.000Z');
    expect(day30).toEqual({ high: 1_010.0, low: 1_000.0, count: 2, dayKey: '2026-07-30' });
  });

  it('KST 하루 경계는 UTC 15:00 ~ 다음날 14:59:59.999 이다', () => {
    const bounds = seoulDayBoundsUtc('2026-07-29T12:00:00.000Z');
    expect(bounds.dayKey).toBe('2026-07-29');
    expect(bounds.startIso).toBe('2026-07-28T15:00:00.000Z');
    expect(bounds.endIso).toBe('2026-07-29T14:59:59.999Z');
  });

  it('UTC 로는 전날이어도 KST 로는 당일이다', () => {
    expect(seoulDayKey('2026-07-28T15:00:00.000Z')).toBe('2026-07-29');
    expect(seoulDayKey('2026-07-28T14:59:59.000Z')).toBe('2026-07-28');
  });

  it('데이터가 없으면 null 을 반환한다', () => {
    expect(rates.dailyExtremes('2026-07-29T14:59:00.000Z')).toBeNull();
  });
});

describe('데이터 보존', () => {
  let db: SqliteDatabase;
  let rates: RateRepository;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    rates = new RateRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('기준 시각보다 오래된 데이터만 삭제한다', () => {
    for (const collectedAt of [
      '2024-01-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z',
      '2026-07-29T00:00:00.000Z',
    ]) {
      rates.insert({
        rate: 946.32,
        changeAmount: null,
        changePercent: null,
        collectedAt,
        source: SOURCE,
      });
    }

    expect(rates.count()).toBe(3);
    const deleted = rates.deleteOlderThan('2025-07-29T00:00:00.000Z');
    expect(deleted).toBe(2);
    expect(rates.count()).toBe(1);
    expect(rates.findLatest()?.collectedAt).toBe('2026-07-29T00:00:00.000Z');
  });
});

describe('app_settings', () => {
  let db: SqliteDatabase;
  let settings: SettingsRepository;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    settings = new SettingsRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('없는 키는 null 을 반환한다', () => {
    expect(settings.get(SettingKey.DISCORD_MESSAGE_ID)).toBeNull();
  });

  it('값을 저장하고 읽는다', () => {
    settings.set(SettingKey.DISCORD_MESSAGE_ID, '1234567890');
    expect(settings.get(SettingKey.DISCORD_MESSAGE_ID)).toBe('1234567890');
  });

  it('같은 키를 다시 저장하면 덮어쓴다 (중복 행이 생기지 않는다)', () => {
    settings.set(SettingKey.NOTION_STATUS_PAGE_ID, 'page-a');
    settings.set(SettingKey.NOTION_STATUS_PAGE_ID, 'page-b');
    expect(settings.get(SettingKey.NOTION_STATUS_PAGE_ID)).toBe('page-b');
    expect(
      settings.all().filter((row) => row.key === SettingKey.NOTION_STATUS_PAGE_ID),
    ).toHaveLength(1);
  });

  it('삭제하면 다시 null 이 된다', () => {
    settings.set(SettingKey.DISCORD_MESSAGE_ID, 'abc');
    settings.delete(SettingKey.DISCORD_MESSAGE_ID);
    expect(settings.get(SettingKey.DISCORD_MESSAGE_ID)).toBeNull();
  });

  it('불리언 헬퍼가 동작한다', () => {
    expect(settings.getBoolean(SettingKey.FAILURE_ALERT_SENT, false)).toBe(false);
    settings.setBoolean(SettingKey.FAILURE_ALERT_SENT, true);
    expect(settings.getBoolean(SettingKey.FAILURE_ALERT_SENT)).toBe(true);
  });
});

describe('health_events', () => {
  let db: SqliteDatabase;
  let health: HealthRepository;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    health = new HealthRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('이벤트를 기록하고 최신순으로 읽는다', () => {
    health.record('scraper', 'error', '첫 번째 실패', '2026-07-29T00:00:00.000Z');
    health.record('scraper', 'error', '두 번째 실패', '2026-07-29T00:01:00.000Z');

    const recent = health.recent(10);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.message).toBe('두 번째 실패');
  });

  it('레벨로 필터링한다', () => {
    health.record('discord', 'warn', '경고');
    health.record('notion', 'error', '오류');
    expect(health.recentByLevel('error')).toHaveLength(1);
    expect(health.recentByLevel('error')[0]?.component).toBe('notion');
  });

  it('메시지가 길어도 저장 시 잘라낸다 (DB 비대화 방지)', () => {
    health.record('scraper', 'error', 'x'.repeat(2_000));
    expect(health.recent(1)[0]?.message.length).toBe(500);
  });
});
