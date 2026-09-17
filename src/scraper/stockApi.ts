/**
 * 네이버 증권(stock.naver.com) 환율 JSON API 응답 해석.
 *
 * 2026-09 부터 finance.naver.com 의 엔화 상세 페이지는 stock.naver.com 의
 * 클라이언트 렌더링 페이지로 리다이렉트되며, HTML 안에 환율 숫자가 없다.
 * 대신 같은 사이트가 쓰는 공개 JSON API 가 인증 없이 열려 있으므로 이를 1순위로 쓴다.
 *
 *   GET https://api.stock.naver.com/marketindex/exchange/FX_JPYKRW
 *   { "exchangeInfo": { "closePrice": "887.50", "calcPrice": "887.5", ... } }
 *
 * `closePrice` 는 "100 JPY 당 KRW" 문자열이다. (fullName: "일본 JPY 100")
 *
 * 이 모듈은 순수 함수만 담는다. 네트워크는 naverJpyScraper 가 담당한다.
 */
import { parseNumericText, round2 } from '../utils/money.js';

export const DEFAULT_STOCK_API_URL = 'https://api.stock.naver.com/marketindex/exchange/FX_JPYKRW';

/** JSON API 경로가 성공했을 때 ScrapeResult.parser 에 기록되는 이름. */
export const STOCK_API_PARSER_NAME = 'stock_api_close_price';

export type StockApiOutcome =
  | { readonly ok: true; readonly value: number; readonly field: 'closePrice' | 'calcPrice' }
  | { readonly ok: false; readonly reason: string };

function pickNumeric(record: Record<string, unknown>, key: string): number | null {
  const raw = record[key];
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  return parseNumericText(raw);
}

/**
 * API 응답 본문(JSON 문자열)에서 100 JPY 당 KRW 값을 꺼낸다.
 *
 * - 본문이 JSON 이 아니거나 구조가 다르면 `ok: false` 를 돌려준다. 예외를 던지지 않는다.
 * - 범위 검사는 스크레이퍼가 수행하므로 여기서는 양의 유한수인지만 본다.
 */
export function parseStockApiBody(body: string): StockApiOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'JSON 이 아님' };
  }

  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, reason: '객체가 아님' };
  }

  const info = (parsed as Record<string, unknown>)['exchangeInfo'];
  if (info === null || typeof info !== 'object') {
    return { ok: false, reason: 'exchangeInfo 없음' };
  }
  const record = info as Record<string, unknown>;

  // 표시용(closePrice)이 정식 값이고 calcPrice 는 계산기용 백업이다.
  for (const field of ['closePrice', 'calcPrice'] as const) {
    const value = pickNumeric(record, field);
    if (value !== null && Number.isFinite(value) && value > 0) {
      return { ok: true, value: round2(value), field };
    }
  }

  return { ok: false, reason: 'closePrice/calcPrice 없음' };
}
