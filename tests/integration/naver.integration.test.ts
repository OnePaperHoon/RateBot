import { describe, expect, it } from 'vitest';
import { NaverJpyScraper } from '../../src/scraper/naverJpyScraper.js';

/**
 * 실제 네이버 금융 서버에 의존하는 통합 테스트.
 *
 * 기본 CI(`npm test`)에서는 실행되지 않는다.
 * 실행 방법:
 *   npm run test:integration
 *
 * 목적:
 *  - 네이버 페이지 구조가 바뀌었는지 조기에 감지한다.
 *  - fixture 가 현실과 얼마나 떨어져 있는지 확인한다.
 */

const ENABLED = process.env.RUN_INTEGRATION_TESTS === 'true';
const URL = 'https://finance.naver.com/marketindex/exchangeDetail.naver?marketindexCd=FX_JPYKRW';

describe.skipIf(!ENABLED)('통합: 네이버 금융 실제 호출', () => {
  const scraper = new NaverJpyScraper({
    url: URL,
    timeoutMs: 15_000,
    minValid: 100,
    maxValid: 2_000,
  });

  it('실제 페이지에서 환율을 수집한다', async () => {
    const result = await scraper.fetchRate();

    expect(result.rate).toBeGreaterThan(100);
    expect(result.rate).toBeLessThan(2_000);
    expect(result.source).toBe(URL);
    expect(result.parser).toBeTruthy();

    // 진단 정보 확인 (2026-09 부터는 JSON API 경로가 정상이다)
    expect(result.diagnostics.httpStatus).toBe(200);
    expect(result.diagnostics.contentType).toMatch(/application\/json/i);
    expect(result.diagnostics.contentLength).toBeGreaterThan(100);
    expect(result.parser).toBe('stock_api_close_price');

    console.log(
      `[통합] 100 JPY = ${result.rate} KRW  (파서: ${result.parser}, ` +
        `${result.diagnostics.contentLength} bytes, ${result.diagnostics.charset})`,
    );
  }, 30_000);

  it('소수점 둘째 자리까지만 유지한다', async () => {
    const result = await scraper.fetchRate();
    expect(Number(result.rate.toFixed(2))).toBe(result.rate);
  }, 30_000);

  it('연속 호출해도 비슷한 값이 나온다 (파서 안정성)', async () => {
    const first = await scraper.fetchRate();
    const second = await scraper.fetchRate();
    // 몇 초 사이에 5% 이상 변동하면 파싱이 잘못됐을 가능성이 높다.
    expect(Math.abs(second.rate - first.rate) / first.rate).toBeLessThan(0.05);
  }, 45_000);
});
