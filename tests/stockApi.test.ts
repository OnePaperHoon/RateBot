import { describe, expect, it } from 'vitest';
import { parseStockApiBody } from '../src/scraper/stockApi.js';

const SAMPLE = JSON.stringify({
  exchangeInfo: {
    reutersCode: 'FX_JPYKRW',
    fullName: '일본 JPY 100',
    localTradedAt: '2026-09-17T16:24:13+09:00',
    closePrice: '887.50',
    fluctuations: '5.73',
    fluctuationsRatio: '0.65',
    calcPrice: '887.5',
  },
  marketIndexCdList: ['FX_JPYKRW'],
});

describe('parseStockApiBody — 네이버 증권 JSON API', () => {
  it('closePrice 를 100 JPY 당 KRW 로 읽는다', () => {
    const outcome = parseStockApiBody(SAMPLE);
    expect(outcome).toEqual({ ok: true, value: 887.5, field: 'closePrice' });
  });

  it('closePrice 가 없으면 calcPrice 로 폴백한다', () => {
    const body = JSON.stringify({ exchangeInfo: { calcPrice: '1,234.567' } });
    expect(parseStockApiBody(body)).toEqual({ ok: true, value: 1234.57, field: 'calcPrice' });
  });

  it('JSON 이 아니면 예외 없이 실패를 돌려준다', () => {
    const outcome = parseStockApiBody('<html><body>점검 중</body></html>');
    expect(outcome.ok).toBe(false);
  });

  it('exchangeInfo 가 없거나 값이 비정상이면 실패한다', () => {
    expect(parseStockApiBody('{}').ok).toBe(false);
    expect(parseStockApiBody('{"exchangeInfo":null}').ok).toBe(false);
    expect(parseStockApiBody('{"exchangeInfo":{"closePrice":"-"}}').ok).toBe(false);
    expect(parseStockApiBody('{"exchangeInfo":{"closePrice":"0"}}').ok).toBe(false);
  });
});
