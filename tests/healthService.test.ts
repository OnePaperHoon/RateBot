import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { closeDatabase, openDatabase } from '../src/database/client.js';
import { HealthRepository } from '../src/database/healthRepository.js';
import { SettingKey, SettingsRepository } from '../src/database/settingsRepository.js';
import { HealthService } from '../src/services/healthService.js';
import type { RateSnapshot } from '../src/types/exchangeRate.js';

const SNAPSHOT: RateSnapshot = {
  rate: 946.32,
  changeAmount: 1.24,
  changePercent: 0.13,
  dailyHigh: 949.1,
  dailyLow: 942.8,
  collectedAt: '2026-07-29T14:45:00.000Z',
  source: 'https://finance.naver.com/marketindex/exchangeDetail.naver?marketindexCd=FX_JPYKRW',
};

describe('HealthService — 연속 실패 알림', () => {
  let db: SqliteDatabase;
  let settings: SettingsRepository;
  let service: HealthService;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    settings = new SettingsRepository(db);
    service = new HealthService({
      settings,
      health: new HealthRepository(db),
      failureAlertThreshold: 5,
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('임계치 미만에서는 알림을 보내지 않는다', () => {
    for (let i = 0; i < 4; i += 1) {
      expect(service.recordFailure(new Error('수집 실패'))).toBe('none');
    }
    expect(service.consecutiveFailures).toBe(4);
  });

  it('임계치에 도달하면 경고를 1회 발송한다', () => {
    for (let i = 0; i < 4; i += 1) service.recordFailure(new Error('수집 실패'));
    expect(service.recordFailure(new Error('수집 실패'))).toBe('send-failure-alert');
  });

  /** 요구사항 6.3: 계속 실패하는 동안 매분 경고를 반복하지 않는다 */
  it('임계치를 넘어 계속 실패해도 경고를 반복하지 않는다', () => {
    for (let i = 0; i < 5; i += 1) service.recordFailure(new Error('수집 실패'));
    for (let i = 0; i < 20; i += 1) {
      expect(service.recordFailure(new Error('수집 실패'))).toBe('none');
    }
    expect(service.consecutiveFailures).toBe(25);
  });

  it('경고 발송 상태를 SQLite 에 저장한다 (재시작 후에도 스팸 방지)', () => {
    for (let i = 0; i < 5; i += 1) service.recordFailure(new Error('실패'));
    expect(settings.getBoolean(SettingKey.FAILURE_ALERT_SENT)).toBe(true);

    // 재시작 시뮬레이션 — 새 인스턴스가 저장된 상태를 이어받는다
    const restarted = new HealthService({
      settings,
      health: new HealthRepository(db),
      failureAlertThreshold: 5,
    });
    expect(restarted.alertActive).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      expect(restarted.recordFailure(new Error('실패'))).toBe('none');
    }
  });
});

describe('HealthService — 복구 알림', () => {
  let db: SqliteDatabase;
  let settings: SettingsRepository;
  let service: HealthService;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    settings = new SettingsRepository(db);
    service = new HealthService({
      settings,
      health: new HealthRepository(db),
      failureAlertThreshold: 5,
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('경고가 발송된 상태에서 성공하면 복구 알림을 1회 보낸다', () => {
    for (let i = 0; i < 5; i += 1) service.recordFailure(new Error('실패'));
    expect(service.recordSuccess(SNAPSHOT)).toBe('send-recovery');
  });

  it('복구 후 이어지는 성공에는 알림을 보내지 않는다', () => {
    for (let i = 0; i < 5; i += 1) service.recordFailure(new Error('실패'));
    service.recordSuccess(SNAPSHOT);

    expect(service.recordSuccess(SNAPSHOT)).toBe('none');
    expect(service.recordSuccess(SNAPSHOT)).toBe('none');
  });

  it('경고 임계치 전에 회복되면 복구 알림도 보내지 않는다', () => {
    service.recordFailure(new Error('일시적 실패'));
    service.recordFailure(new Error('일시적 실패'));
    expect(service.recordSuccess(SNAPSHOT)).toBe('none');
  });

  it('복구 후 다시 실패하면 경고를 새로 보낼 수 있다', () => {
    for (let i = 0; i < 5; i += 1) service.recordFailure(new Error('실패'));
    service.recordSuccess(SNAPSHOT);
    expect(settings.getBoolean(SettingKey.FAILURE_ALERT_SENT)).toBe(false);

    for (let i = 0; i < 4; i += 1) service.recordFailure(new Error('재발'));
    expect(service.recordFailure(new Error('재발'))).toBe('send-failure-alert');
  });

  it('성공하면 연속 실패 카운터가 0 으로 초기화된다', () => {
    service.recordFailure(new Error('실패'));
    service.recordFailure(new Error('실패'));
    expect(service.consecutiveFailures).toBe(2);

    service.recordSuccess(SNAPSHOT);
    expect(service.consecutiveFailures).toBe(0);
  });
});

describe('HealthService — 상태 스냅샷', () => {
  let db: SqliteDatabase;
  let service: HealthService;

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    service = new HealthService({
      settings: new SettingsRepository(db),
      health: new HealthRepository(db),
      failureAlertThreshold: 5,
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('초기 상태를 반환한다', () => {
    const snapshot = service.snapshot();
    expect(snapshot.consecutiveFailures).toBe(0);
    expect(snapshot.lastSuccessAt).toBeNull();
    expect(snapshot.lastFailureAt).toBeNull();
    expect(snapshot.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('성공/실패 시각을 기록한다', () => {
    service.recordSuccess(SNAPSHOT);
    expect(service.snapshot().lastSuccessAt).toBe(SNAPSHOT.collectedAt);

    service.recordFailure(new Error('네트워크 오류'), '2026-07-29T15:00:00.000Z');
    const snapshot = service.snapshot();
    expect(snapshot.lastFailureAt).toBe('2026-07-29T15:00:00.000Z');
    expect(snapshot.lastFailureReason).toContain('네트워크 오류');
  });

  it('재시작 후 마지막 수집 시각을 DB 값으로 복원한다', () => {
    service.hydrateFromLastRecord('2026-07-29T14:00:00.000Z');
    expect(service.snapshot().lastSuccessAt).toBe('2026-07-29T14:00:00.000Z');
  });

  it('이미 성공 이력이 있으면 복원이 덮어쓰지 않는다', () => {
    service.recordSuccess(SNAPSHOT);
    service.hydrateFromLastRecord('2020-01-01T00:00:00.000Z');
    expect(service.snapshot().lastSuccessAt).toBe(SNAPSHOT.collectedAt);
  });
});
