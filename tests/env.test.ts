import { describe, expect, it } from 'vitest';
import { maskId, maskSecret, summarizeEnv, validateEnv } from '../src/config/env.js';

/** 최소한의 유효한 환경변수 집합. */
function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: 'MTIzNDU2Nzg5MDEyMzQ1Njc4.EXAMPLE.FAKE_TOKEN_FOR_TESTS',
    DISCORD_CLIENT_ID: '123456789012345678',
    DISCORD_GUILD_ID: '123456789012345678',
    DISCORD_CHANNEL_ID: '123456789012345678',
    NOTION_ENABLED: 'false',
    ...overrides,
  };
}

describe('환경변수 검증 — 필수 값', () => {
  it('필수 값이 모두 있으면 통과한다', () => {
    const result = validateEnv(baseEnv());
    expect(result.ok).toBe(true);
  });

  it('DISCORD_TOKEN 이 없으면 실패한다', () => {
    const env = baseEnv();
    delete env.DISCORD_TOKEN;
    const result = validateEnv(env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.key === 'DISCORD_TOKEN')).toBe(true);
  });

  it('Discord ID 형식이 잘못되면 실패한다', () => {
    const result = validateEnv(baseEnv({ DISCORD_CHANNEL_ID: 'not-a-snowflake' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.key === 'DISCORD_CHANNEL_ID')).toBe(true);
  });

  it('오류 메시지에 실제 값이 노출되지 않는다', () => {
    const result = validateEnv(baseEnv({ DISCORD_TOKEN: 'short' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const combined = result.issues.map((issue) => issue.message).join(' ');
    expect(combined).not.toContain('short');
  });
});

describe('환경변수 검증 — 기본값', () => {
  it('생략한 값은 기본값이 적용된다', () => {
    const result = validateEnv(baseEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.env.SCRAPE_INTERVAL_SECONDS).toBe(60);
    expect(result.env.REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(result.env.STALE_AFTER_MINUTES).toBe(5);
    expect(result.env.FAILURE_ALERT_THRESHOLD).toBe(5);
    expect(result.env.MIN_VALID_JPY100_KRW).toBe(100);
    expect(result.env.MAX_VALID_JPY100_KRW).toBe(2_000);
    expect(result.env.DATA_RETENTION_DAYS).toBe(365);
    expect(result.env.NOTION_HISTORY_INTERVAL_MINUTES).toBe(60);
    expect(result.env.NAVER_JPY_URL).toContain('FX_JPYKRW');
  });

  it('빈 문자열도 기본값으로 대체한다', () => {
    const result = validateEnv(baseEnv({ SCRAPE_INTERVAL_SECONDS: '', SQLITE_PATH: '' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.SCRAPE_INTERVAL_SECONDS).toBe(60);
    expect(result.env.SQLITE_PATH).toContain('yenwatch.db');
  });
});

describe('환경변수 검증 — 유효 범위', () => {
  it('MIN 이 MAX 보다 크면 실패한다', () => {
    const result = validateEnv(
      baseEnv({ MIN_VALID_JPY100_KRW: '2000', MAX_VALID_JPY100_KRW: '100' }),
    );
    expect(result.ok).toBe(false);
  });

  it('유효 범위는 환경변수로 변경할 수 있다', () => {
    const result = validateEnv(
      baseEnv({ MIN_VALID_JPY100_KRW: '500', MAX_VALID_JPY100_KRW: '1500' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.MIN_VALID_JPY100_KRW).toBe(500);
    expect(result.env.MAX_VALID_JPY100_KRW).toBe(1_500);
  });

  it('수집 주기가 너무 짧으면 거부한다', () => {
    expect(validateEnv(baseEnv({ SCRAPE_INTERVAL_SECONDS: '1' })).ok).toBe(false);
  });

  it('숫자가 아닌 값은 거부한다', () => {
    expect(validateEnv(baseEnv({ REQUEST_TIMEOUT_MS: 'abc' })).ok).toBe(false);
  });
});

describe('환경변수 검증 — Notion 조건부 필수', () => {
  it('NOTION_ENABLED=true 면 토큰과 데이터 소스 ID 가 필요하다', () => {
    const result = validateEnv(baseEnv({ NOTION_ENABLED: 'true' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const keys = result.issues.map((issue) => issue.key);
    expect(keys).toContain('NOTION_TOKEN');
    expect(keys).toContain('NOTION_DATA_SOURCE_ID');
  });

  it('값이 갖춰지면 통과한다', () => {
    const result = validateEnv(
      baseEnv({
        NOTION_ENABLED: 'true',
        NOTION_TOKEN: 'ntn_FAKE_TOKEN_FOR_TESTS',
        NOTION_DATA_SOURCE_ID: '00000000-0000-0000-0000-000000000000',
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('이력을 켜면 이력 데이터 소스 ID 가 필요하다', () => {
    const result = validateEnv(
      baseEnv({
        NOTION_ENABLED: 'true',
        NOTION_TOKEN: 'ntn_FAKE_TOKEN_FOR_TESTS',
        NOTION_DATA_SOURCE_ID: '00000000-0000-0000-0000-000000000000',
        NOTION_HISTORY_ENABLED: 'true',
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.key === 'NOTION_HISTORY_DATA_SOURCE_ID')).toBe(true);
  });

  it('Notion 을 끈 채 이력만 켤 수는 없다', () => {
    const result = validateEnv(
      baseEnv({
        NOTION_ENABLED: 'false',
        NOTION_HISTORY_ENABLED: 'true',
        NOTION_HISTORY_DATA_SOURCE_ID: '00000000-0000-0000-0000-000000000000',
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('환경변수 검증 — 목록 및 불리언 파싱', () => {
  it('쉼표 구분 사용자 ID 를 배열로 만든다', () => {
    const result = validateEnv(
      baseEnv({ DISCORD_ALLOWED_USER_IDS: '111111111111111111, 222222222222222222 ' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.DISCORD_ALLOWED_USER_IDS).toEqual([
      '111111111111111111',
      '222222222222222222',
    ]);
  });

  it('비어 있으면 빈 배열이다 (아무도 /yen-refresh 를 쓸 수 없다)', () => {
    const result = validateEnv(baseEnv({ DISCORD_ALLOWED_USER_IDS: '' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.DISCORD_ALLOWED_USER_IDS).toEqual([]);
  });

  it('다양한 불리언 표기를 인식한다', () => {
    for (const value of ['true', 'TRUE', '1', 'yes', 'on']) {
      const result = validateEnv(
        baseEnv({
          NOTION_ENABLED: value,
          NOTION_TOKEN: 'ntn_FAKE',
          NOTION_DATA_SOURCE_ID: 'ds-id',
        }),
      );
      expect(result.ok, `${value} 는 true 여야 함`).toBe(true);
      if (result.ok) expect(result.env.NOTION_ENABLED).toBe(true);
    }

    for (const value of ['false', 'FALSE', '0', 'no', 'off']) {
      const result = validateEnv(baseEnv({ NOTION_ENABLED: value }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.env.NOTION_ENABLED).toBe(false);
    }
  });
});

describe('비밀정보 마스킹', () => {
  it('토큰은 앞 4자만 노출한다', () => {
    const masked = maskSecret('MTIzNDU2Nzg5MDEyMzQ1Njc4.SUPER.SECRET');
    expect(masked.startsWith('MTIz')).toBe(true);
    expect(masked).not.toContain('SECRET');
  });

  it('짧은 값은 완전히 가린다', () => {
    expect(maskSecret('short')).toBe('****');
  });

  it('빈 값은 (미설정) 으로 표시한다', () => {
    expect(maskSecret('')).toBe('(미설정)');
    expect(maskId('')).toBe('(미설정)');
  });

  it('요약 출력에 원본 토큰이 들어가지 않는다', () => {
    const result = validateEnv(baseEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const summary = JSON.stringify(summarizeEnv(result.env));
    expect(summary).not.toContain('FAKE_TOKEN_FOR_TESTS');
  });
});
