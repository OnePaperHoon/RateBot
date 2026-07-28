import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { AlertRepository } from '../src/database/alertRepository.js';
import { closeDatabase, openDatabase } from '../src/database/client.js';
import {
  ALERT_REMOVE_MENU_ID,
  BOARD_COOLDOWN_MS,
  buildAlertRemoveMenu,
  commandDefinitions,
} from '../src/discord/commands.js';

const OWNER = '111111111111111111';
const OTHER = '222222222222222222';
const ADMIN = '333333333333333333';
const CHANNEL = '444444444444444444';

/**
 * Discord 는 선택 메뉴에 하드 리밋이 있고, 넘기면 API 가 400 을 던진다.
 *  - 옵션 최대 25개
 *  - label / description 각각 최대 100자
 * 런타임에서 터지지 않도록 여기서 고정한다.
 */
describe('알림 삭제 드롭다운', () => {
  let db: SqliteDatabase;
  let alerts: AlertRepository;

  function add(createdBy: string, target = 940, label?: string) {
    return alerts.create({
      targetRate: target,
      direction: 'below',
      mentionUserId: createdBy,
      createdBy,
      channelId: CHANNEL,
      label: label ?? null,
    });
  }

  /** 만들어진 메뉴의 JSON 에서 옵션 배열을 꺼낸다. */
  function optionsOf(row: NonNullable<ReturnType<typeof buildAlertRemoveMenu>>) {
    const json = row.toJSON() as {
      components: Array<{
        options?: Array<{ label: string; description?: string; value: string }>;
      }>;
    };
    return json.components[0]?.options ?? [];
  }

  beforeEach(() => {
    db = openDatabase({ filePath: ':memory:' });
    alerts = new AlertRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('알림이 없으면 메뉴를 만들지 않는다', () => {
    expect(buildAlertRemoveMenu([], OWNER, [])).toBeNull();
  });

  it('내가 만든 알림만 목록에 들어간다', () => {
    add(OWNER, 940);
    add(OTHER, 950);

    const row = buildAlertRemoveMenu(alerts.findAll(), OWNER, []);
    expect(row).not.toBeNull();

    const options = optionsOf(row!);
    expect(options).toHaveLength(1);
    expect(options[0]?.label).toContain('940.00 KRW 이하');
  });

  it('삭제할 수 있는 알림이 없으면 메뉴가 없다', () => {
    add(OTHER, 950);
    expect(buildAlertRemoveMenu(alerts.findAll(), OWNER, [])).toBeNull();
  });

  it('허용된 사용자는 남의 알림도 목록에 보인다', () => {
    add(OWNER, 940);
    add(OTHER, 950);

    const row = buildAlertRemoveMenu(alerts.findAll(), ADMIN, [ADMIN]);
    expect(optionsOf(row!)).toHaveLength(2);
  });

  it('customId 에 요청자 ID 가 들어간다 (다른 사람이 못 쓰게)', () => {
    add(OWNER);
    const json = buildAlertRemoveMenu(alerts.findAll(), OWNER, [])!.toJSON() as {
      components: Array<{ custom_id?: string }>;
    };
    expect(json.components[0]?.custom_id).toBe(`${ALERT_REMOVE_MENU_ID}:${OWNER}`);
  });

  it('옵션 값은 알림 ID 문자열이다', () => {
    const created = add(OWNER);
    const options = optionsOf(buildAlertRemoveMenu(alerts.findAll(), OWNER, [])!);
    expect(options[0]?.value).toBe(String(created.id));
  });

  it('알림이 25개를 넘으면 25개로 자른다 (Discord 상한)', () => {
    for (let i = 0; i < 40; i += 1) add(OWNER, 900 + i);
    const options = optionsOf(buildAlertRemoveMenu(alerts.findAll(), OWNER, [])!);
    expect(options).toHaveLength(25);
  });

  it('여러 개를 한 번에 선택할 수 있다', () => {
    for (let i = 0; i < 3; i += 1) add(OWNER, 900 + i);
    const json = buildAlertRemoveMenu(alerts.findAll(), OWNER, [])!.toJSON() as {
      components: Array<{ min_values?: number; max_values?: number }>;
    };
    expect(json.components[0]?.min_values).toBe(1);
    expect(json.components[0]?.max_values).toBe(3);
  });

  it('아주 긴 메모가 있어도 label/description 이 100자를 넘지 않는다', () => {
    add(OWNER, 940, 'x'.repeat(500));
    const options = optionsOf(buildAlertRemoveMenu(alerts.findAll(), OWNER, [])!);
    for (const option of options) {
      expect(option.label.length).toBeLessThanOrEqual(100);
      expect((option.description ?? '').length).toBeLessThanOrEqual(100);
    }
  });

  it('메뉴 전체가 Discord API 로 직렬화된다 (빌더 검증 통과)', () => {
    add(OWNER, 940, '여행 경비');
    expect(() => buildAlertRemoveMenu(alerts.findAll(), OWNER, [])!.toJSON()).not.toThrow();
  });
});

describe('슬래시 커맨드 정의', () => {
  it('등록 대상 커맨드 6종이 모두 포함된다', () => {
    const names = commandDefinitions().map((command) => command.name);
    expect(names).toEqual([
      'yen',
      'yen-history',
      'yen-status',
      'yen-refresh',
      'yen-alert',
      'yen-board',
    ]);
  });

  it('모든 커맨드에 설명이 있다 (Discord 필수)', () => {
    for (const command of commandDefinitions()) {
      expect(command.description).toBeTruthy();
      expect(command.description!.length).toBeLessThanOrEqual(100);
    }
  });

  it('/yen-alert 는 add / list / remove 서브커맨드를 가진다', () => {
    const alertCommand = commandDefinitions().find((command) => command.name === 'yen-alert');
    const subNames = (alertCommand?.options ?? []).map((option) => option.name);
    expect(subNames).toEqual(['add', 'list', 'remove']);
  });

  it('/yen-board 쿨다운이 설정되어 있다', () => {
    expect(BOARD_COOLDOWN_MS).toBeGreaterThan(0);
  });
});
