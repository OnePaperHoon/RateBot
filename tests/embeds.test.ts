import { describe, expect, it } from 'vitest';
import {
  buildCurrentRateEmbed,
  buildHistoryEmbed,
  buildStatusEmbed,
  formatChangeLine,
  formatIntervalLabel,
} from '../src/discord/embeds.js';
import type { RangeStats, RateSnapshot } from '../src/types/exchangeRate.js';

const NOW = new Date('2026-07-29T14:45:00.000Z'); // KST 2026-07-29 23:45

const SNAPSHOT: RateSnapshot = {
  rate: 946.32,
  changeAmount: 1.24,
  changePercent: 0.13,
  dailyHigh: 949.1,
  dailyLow: 942.8,
  collectedAt: '2026-07-29T14:45:00.000Z',
  source: 'https://finance.naver.com/marketindex/exchangeDetail.naver?marketindexCd=FX_JPYKRW',
};

const OPTIONS = { staleAfterMinutes: 5, scrapeIntervalSeconds: 60, now: NOW };

/** Embed 전체를 문자열로 평탄화해 내용 검증에 사용한다. */
function flatten(embed: { toJSON(): unknown }): string {
  return JSON.stringify(embed.toJSON());
}

describe('formatChangeLine', () => {
  it('상승은 ▲ 와 + 부호를 쓴다', () => {
    expect(formatChangeLine(1.24, 0.13)).toBe('▲ +1.24 KRW (+0.13%)');
  });

  it('하락은 ▼ 와 - 부호를 쓴다', () => {
    expect(formatChangeLine(-1.24, -0.13)).toBe('▼ -1.24 KRW (-0.13%)');
  });

  it('동일은 ― 를 쓴다', () => {
    expect(formatChangeLine(0, 0)).toBe('― 0.00 KRW (0.00%)');
  });

  it('이전 데이터가 없으면 안내 문구를 보여준다', () => {
    expect(formatChangeLine(null, null)).toContain('이전 데이터가 없습니다');
  });
});

describe('buildStatusEmbed — 정상 상태', () => {
  it('요구사항의 모든 항목을 포함한다', () => {
    const content = flatten(buildStatusEmbed(SNAPSHOT, OPTIONS));

    expect(content).toContain('YenWatch');
    expect(content).toContain('현재 엔화 환율');
    expect(content).toContain('100 JPY = 946.32 KRW');
    expect(content).toContain('전회 대비');
    expect(content).toContain('▲ +1.24 KRW (+0.13%)');
    expect(content).toContain('오늘 범위');
    expect(content).toContain('949.10');
    expect(content).toContain('942.80');
    expect(content).toContain('수집 시각');
    expect(content).toContain('데이터 출처');
    expect(content).toContain('네이버 금융');
  });

  it('Asia/Seoul 시각과 Discord 타임스탬프를 함께 표시한다', () => {
    const content = flatten(buildStatusEmbed(SNAPSHOT, OPTIONS));
    expect(content).toContain('2026-07-29 23:45:00 KST');
    // <t:UNIX:R> 형태의 Discord 동적 타임스탬프
    expect(content).toMatch(/<t:\d+:R>/);
  });

  it('footer 에 갱신 주기를 표시한다', () => {
    expect(flatten(buildStatusEmbed(SNAPSHOT, OPTIONS))).toContain('1분마다 자동 갱신');
  });

  it('정상 상태에서는 경고 문구가 없다', () => {
    expect(flatten(buildStatusEmbed(SNAPSHOT, OPTIONS))).not.toContain('갱신되지 않았습니다');
  });

  it('상승/하락에 따라 색상이 달라진다', () => {
    const up = buildStatusEmbed(SNAPSHOT, OPTIONS).toJSON().color;
    const down = buildStatusEmbed(
      { ...SNAPSHOT, changeAmount: -1.24, changePercent: -0.13 },
      OPTIONS,
    ).toJSON().color;
    expect(up).not.toBe(down);
  });
});

describe('buildStatusEmbed — 오래된 데이터 경고', () => {
  it('STALE_AFTER_MINUTES 를 넘기면 경고를 표시한다', () => {
    const stale = { ...SNAPSHOT, collectedAt: '2026-07-29T14:30:00.000Z' }; // 15분 전
    const content = flatten(
      buildStatusEmbed(stale, {
        ...OPTIONS,
        lastFailureAt: '2026-07-29T14:44:00.000Z',
        lastFailureReason: 'HTTP 503',
        consecutiveFailures: 3,
      }),
    );

    expect(content).toContain('갱신되지 않았습니다');
    expect(content).toContain('마지막으로 정상 수집된 데이터');
    expect(content).toContain('오류 발생');
    expect(content).toContain('연속 실패: 3회');
    expect(content).toContain('HTTP 503');
  });

  it('경고 상태여도 마지막 정상 환율은 그대로 보여준다', () => {
    const stale = { ...SNAPSHOT, collectedAt: '2026-07-29T14:00:00.000Z' };
    expect(flatten(buildStatusEmbed(stale, OPTIONS))).toContain('100 JPY = 946.32 KRW');
  });

  it('임계치 이내면 경고하지 않는다', () => {
    const fresh = { ...SNAPSHOT, collectedAt: '2026-07-29T14:42:00.000Z' }; // 3분 전
    expect(flatten(buildStatusEmbed(fresh, OPTIONS))).not.toContain('갱신되지 않았습니다');
  });
});

describe('buildStatusEmbed — 데이터 없음', () => {
  it('수집 데이터가 없으면 안내 메시지를 보여준다', () => {
    const content = flatten(buildStatusEmbed(null, OPTIONS));
    expect(content).toContain('아직 수집된 환율 데이터가 없습니다');
  });
});

describe('buildCurrentRateEmbed (/yen)', () => {
  it('현재 환율, 전회 대비, 당일 고저, 수집 시각을 담는다', () => {
    const content = flatten(buildCurrentRateEmbed(SNAPSHOT, OPTIONS));
    expect(content).toContain('100 JPY = 946.32 KRW');
    expect(content).toContain('전회 대비');
    expect(content).toContain('당일 최고 / 최저');
    expect(content).toContain('949.10 / 942.80');
    expect(content).toContain('최근 수집 시각');
  });

  it('데이터가 없으면 안내한다', () => {
    expect(flatten(buildCurrentRateEmbed(null, OPTIONS))).toContain(
      '아직 수집된 데이터가 없습니다',
    );
  });
});

describe('buildHistoryEmbed (/yen-history)', () => {
  const stats: RangeStats = {
    periodLabel: '최근 24시간',
    openRate: 940.0,
    closeRate: 946.32,
    high: 949.1,
    low: 938.2,
    changeAmount: 6.32,
    changePercent: 0.67,
    dataPoints: 1_440,
    series: [940.0, 942.5, 949.1, 938.2, 946.32],
    firstAt: '2026-07-28T14:45:00.000Z',
    lastAt: '2026-07-29T14:45:00.000Z',
  };

  it('요구사항의 7개 항목을 모두 표시한다', () => {
    const content = flatten(buildHistoryEmbed(stats, '24h'));
    expect(content).toContain('시작 환율');
    expect(content).toContain('940.00');
    expect(content).toContain('현재 환율');
    expect(content).toContain('946.32');
    expect(content).toContain('최고가');
    expect(content).toContain('949.10');
    expect(content).toContain('최저가');
    expect(content).toContain('938.20');
    expect(content).toContain('+6.32');
    expect(content).toContain('+0.67%');
    expect(content).toContain('1440건');
  });

  it('스파크라인을 함께 표시한다', () => {
    const content = flatten(buildHistoryEmbed(stats, '24h'));
    expect(content).toMatch(/[▁▂▃▄▅▆▇█]/);
  });

  it('데이터가 없으면 안내한다', () => {
    expect(flatten(buildHistoryEmbed(null, '7d'))).toContain('저장된 데이터가 없습니다');
  });
});

describe('formatIntervalLabel', () => {
  it('60초는 1분마다', () => {
    expect(formatIntervalLabel(60)).toBe('1분마다');
  });

  it('300초는 5분마다', () => {
    expect(formatIntervalLabel(300)).toBe('5분마다');
  });

  it('분 단위로 떨어지지 않으면 초로 표시한다', () => {
    expect(formatIntervalLabel(90)).toBe('90초마다');
  });
});
