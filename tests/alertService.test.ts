import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { AlertRepository, type AlertDirection } from '../src/database/alertRepository.js';
import { closeDatabase, openDatabase } from '../src/database/client.js';
import { HealthRepository } from '../src/database/healthRepository.js';
import { AlertService } from '../src/services/alertService.js';
import { buildAlertEmbed, formatAlertCondition } from '../src/discord/embeds.js';
import type { RateSnapshot } from '../src/types/exchangeRate.js';

const SOURCE = 'https://finance.naver.com/marketindex/exchangeDetail.naver?marketindexCd=FX_JPYKRW';
const USER = '111111111111111111';
const CHANNEL = '222222222222222222';

function snapshotAt(rate: number): RateSnapshot {
  return {
    rate,
    changeAmount: null,
    changePercent: null,
    dailyHigh: rate,
    dailyLow: rate,
    collectedAt: '2026-07-29T14:45:00.000Z',
    source: SOURCE,
  };
}

describe('AlertService — 발동 조건', () => {
  let db: SqliteDatabase;
  let alerts: AlertRepository;
  let service: AlertService;

  function addAlert(target: number, direction: AlertDirection, once = false) {
    return alerts.create({
      targetRate: target,
      direction,
      mentionUserId: USER,
      createdBy: USER,
      channelId: CHANNEL,
      once,
    });
  }

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    alerts = new AlertRepository(db);
    service = new AlertService({
      alerts,
      health: new HealthRepository(db),
      rearmMarginKrw: 1,
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('목표 이하로 내려가면 발동한다', () => {
    addAlert(940, 'below');
    const triggers = service.evaluate(snapshotAt(939.5));
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.rate).toBe(939.5);
  });

  it('목표에 정확히 같아도 발동한다 (이하 = 포함)', () => {
    addAlert(940, 'below');
    expect(service.evaluate(snapshotAt(940))).toHaveLength(1);
  });

  it('목표보다 높으면 발동하지 않는다', () => {
    addAlert(940, 'below');
    expect(service.evaluate(snapshotAt(941))).toHaveLength(0);
  });

  it('위 방향 알림은 목표 이상일 때 발동한다', () => {
    addAlert(960, 'above');
    expect(service.evaluate(snapshotAt(959))).toHaveLength(0);
    expect(service.evaluate(snapshotAt(960.5))).toHaveLength(1);
  });

  it('여러 알림이 동시에 발동할 수 있다', () => {
    addAlert(940, 'below');
    addAlert(945, 'below');
    addAlert(950, 'below');
    expect(service.evaluate(snapshotAt(939))).toHaveLength(3);
  });

  it('조건을 만족하지 않는 알림은 건너뛴다', () => {
    addAlert(940, 'below');
    addAlert(900, 'below');
    const triggers = service.evaluate(snapshotAt(939));
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.alert.targetRate).toBe(940);
  });

  it('알림이 없으면 빈 배열', () => {
    expect(service.evaluate(snapshotAt(939))).toEqual([]);
  });
});

/**
 * 이 그룹이 이 기능의 핵심이다.
 * 1분마다 수집하므로 스팸 방지가 안 되면 하루 1,440번 멘션이 갈 수 있다.
 */
describe('AlertService — 스팸 방지 (재무장 히스테리시스)', () => {
  let db: SqliteDatabase;
  let alerts: AlertRepository;
  let service: AlertService;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    alerts = new AlertRepository(db);
    service = new AlertService({
      alerts,
      health: new HealthRepository(db),
      rearmMarginKrw: 1,
    });
    alerts.create({
      targetRate: 940,
      direction: 'below',
      mentionUserId: USER,
      createdBy: USER,
      channelId: CHANNEL,
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('조건이 계속 유지돼도 한 번만 발동한다', () => {
    expect(service.evaluate(snapshotAt(939.5))).toHaveLength(1);

    // 같은 조건이 20분간 유지되는 상황
    for (let i = 0; i < 20; i += 1) {
      expect(service.evaluate(snapshotAt(939.5 - i * 0.01))).toHaveLength(0);
    }
  });

  it('목표선을 살짝 벗어난 정도로는 재무장하지 않는다', () => {
    service.evaluate(snapshotAt(939.5)); // 발동
    service.evaluate(snapshotAt(940.5)); // 조건 밖이지만 margin(1.0) 미달
    // 다시 내려가도 조용해야 한다
    expect(service.evaluate(snapshotAt(939.0))).toHaveLength(0);
  });

  it('목표선에서 margin 이상 벗어나면 재무장하고 다시 발동한다', () => {
    expect(service.evaluate(snapshotAt(939.5))).toHaveLength(1);
    service.evaluate(snapshotAt(941.0)); // 940 + 1.0 -> 재무장
    expect(service.evaluate(snapshotAt(939.0))).toHaveLength(1);
  });

  it('경계선에서 흔들려도 멘션이 반복되지 않는다', () => {
    const wobble = [939.9, 940.1, 939.8, 940.2, 939.95, 940.05, 939.99];
    const fired = wobble.reduce(
      (count, rate) => count + service.evaluate(snapshotAt(rate)).length,
      0,
    );
    // 첫 진입 1회만 울려야 한다
    expect(fired).toBe(1);
  });

  it('위 방향 알림도 같은 방식으로 억제된다', () => {
    const upDb = openDatabase({ filePath: ':memory:' });
    const upAlerts = new AlertRepository(upDb);
    const upService = new AlertService({
      alerts: upAlerts,
      health: new HealthRepository(upDb),
      rearmMarginKrw: 1,
    });
    upAlerts.create({
      targetRate: 960,
      direction: 'above',
      mentionUserId: USER,
      createdBy: USER,
      channelId: CHANNEL,
    });

    expect(upService.evaluate(snapshotAt(960.5))).toHaveLength(1);
    expect(upService.evaluate(snapshotAt(961.0))).toHaveLength(0);
    upService.evaluate(snapshotAt(959.0)); // 960 - 1.0 -> 재무장
    expect(upService.evaluate(snapshotAt(960.2))).toHaveLength(1);

    closeDatabase(upDb);
  });

  it('margin 이 0 이면 조건을 벗어나는 즉시 재무장한다', () => {
    const zeroDb = openDatabase({ filePath: ':memory:' });
    const zeroAlerts = new AlertRepository(zeroDb);
    const zeroService = new AlertService({
      alerts: zeroAlerts,
      health: new HealthRepository(zeroDb),
      rearmMarginKrw: 0,
    });
    zeroAlerts.create({
      targetRate: 940,
      direction: 'below',
      mentionUserId: USER,
      createdBy: USER,
      channelId: CHANNEL,
    });

    expect(zeroService.evaluate(snapshotAt(939))).toHaveLength(1);
    expect(zeroService.evaluate(snapshotAt(940.01))).toHaveLength(0); // 재무장
    expect(zeroService.evaluate(snapshotAt(939))).toHaveLength(1);

    closeDatabase(zeroDb);
  });
});

describe('AlertService — 1회성 알림', () => {
  let db: SqliteDatabase;
  let alerts: AlertRepository;
  let service: AlertService;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    alerts = new AlertRepository(db);
    service = new AlertService({
      alerts,
      health: new HealthRepository(db),
      rearmMarginKrw: 1,
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('한 번 발동하면 비활성화된다', () => {
    const created = alerts.create({
      targetRate: 940,
      direction: 'below',
      mentionUserId: USER,
      createdBy: USER,
      channelId: CHANNEL,
      once: true,
    });

    expect(service.evaluate(snapshotAt(939))).toHaveLength(1);
    expect(alerts.findById(created.id)?.enabled).toBe(false);

    // 재무장 구간을 지나도 다시 울리지 않는다
    service.evaluate(snapshotAt(945));
    expect(service.evaluate(snapshotAt(938))).toHaveLength(0);
  });

  it('반복 알림은 발동 후에도 활성 상태를 유지한다', () => {
    const created = alerts.create({
      targetRate: 940,
      direction: 'below',
      mentionUserId: USER,
      createdBy: USER,
      channelId: CHANNEL,
      once: false,
    });

    service.evaluate(snapshotAt(939));
    const after = alerts.findById(created.id);
    expect(after?.enabled).toBe(true);
    expect(after?.armed).toBe(false);
  });
});

describe('AlertRepository', () => {
  let db: SqliteDatabase;
  let alerts: AlertRepository;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    alerts = new AlertRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('알림을 만들고 조회한다', () => {
    const created = alerts.create({
      targetRate: 940.5,
      direction: 'below',
      mentionUserId: USER,
      createdBy: USER,
      channelId: CHANNEL,
      label: '여행 경비',
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.armed).toBe(true);
    expect(created.enabled).toBe(true);
    expect(created.triggerCount).toBe(0);
    expect(created.label).toBe('여행 경비');
    expect(alerts.findById(created.id)?.targetRate).toBe(940.5);
  });

  it('목표 환율은 소수점 둘째 자리로 반올림된다', () => {
    const created = alerts.create({
      targetRate: 940.567,
      direction: 'below',
      mentionUserId: USER,
      createdBy: USER,
      channelId: CHANNEL,
    });
    expect(created.targetRate).toBe(940.57);
  });

  it('발동 횟수와 시각을 기록한다', () => {
    const created = alerts.create({
      targetRate: 940,
      direction: 'below',
      mentionUserId: USER,
      createdBy: USER,
      channelId: CHANNEL,
    });

    alerts.markTriggered(created.id, 939.2, '2026-07-29T14:45:00.000Z');
    const after = alerts.findById(created.id);
    expect(after?.triggerCount).toBe(1);
    expect(after?.armed).toBe(false);
    expect(after?.lastTriggeredRate).toBe(939.2);
    expect(after?.lastTriggeredAt).toBe('2026-07-29T14:45:00.000Z');
  });

  it('본인이 만든 알림만 삭제하는 변형이 동작한다', () => {
    const created = alerts.create({
      targetRate: 940,
      direction: 'below',
      mentionUserId: USER,
      createdBy: USER,
      channelId: CHANNEL,
    });

    expect(alerts.deleteOwnedBy(created.id, '999999999999999999')).toBe(false);
    expect(alerts.deleteOwnedBy(created.id, USER)).toBe(true);
    expect(alerts.findById(created.id)).toBeNull();
  });

  it('활성 알림 수를 사용자별로 센다', () => {
    for (let i = 0; i < 3; i += 1) {
      alerts.create({
        targetRate: 940 + i,
        direction: 'below',
        mentionUserId: USER,
        createdBy: USER,
        channelId: CHANNEL,
      });
    }
    expect(alerts.countActiveByCreator(USER)).toBe(3);
    expect(alerts.countActiveByCreator('999999999999999999')).toBe(0);
  });

  it('비활성 알림은 평가 대상에서 제외된다', () => {
    const created = alerts.create({
      targetRate: 940,
      direction: 'below',
      mentionUserId: USER,
      createdBy: USER,
      channelId: CHANNEL,
    });
    alerts.setEnabled(created.id, false);
    expect(alerts.findEnabled()).toHaveLength(0);
    expect(alerts.findAll()).toHaveLength(1);
  });
});

describe('알림 메시지', () => {
  it('조건 문구를 방향에 맞게 만든다', () => {
    expect(formatAlertCondition('below', 940)).toBe('940.00 KRW 이하');
    expect(formatAlertCondition('above', 960.5)).toBe('960.50 KRW 이상');
  });

  it('발동 Embed 에 요청한 문구와 환율이 들어간다', () => {
    const db = openDatabase({ filePath: ':memory:' });
    const alerts = new AlertRepository(db);
    const alert = alerts.create({
      targetRate: 940,
      direction: 'below',
      mentionUserId: USER,
      createdBy: USER,
      channelId: CHANNEL,
      label: '여행 경비 환전',
    });

    const content = JSON.stringify(buildAlertEmbed(alert, snapshotAt(939.2)).toJSON());
    expect(content).toContain('환전 타이밍입니다!!!!!');
    expect(content).toContain('100 JPY = 939.20 KRW');
    expect(content).toContain('940.00 KRW 이하');
    expect(content).toContain('여행 경비 환전');

    closeDatabase(db);
  });
});
