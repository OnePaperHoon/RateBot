import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AxiosInstance } from 'axios';
import iconv from 'iconv-lite';

import { NaverJpyScraper } from '../src/scraper/naverJpyScraper.js';
import { STOCK_API_PARSER_NAME } from '../src/scraper/stockApi.js';
import { ParseError, RateValidationError } from '../src/errors.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PAGE_URL =
  'https://finance.naver.com/marketindex/exchangeDetail.naver?marketindexCd=FX_JPYKRW';
const API_URL = 'https://api.stock.naver.com/marketindex/exchange/FX_JPYKRW';

interface StubResponse {
  status?: number;
  body?: Buffer;
  contentType?: string;
  throws?: Error;
}

/** URL 별로 다른 응답을 돌려주는 axios 대역. 호출 순서를 기록한다. */
function stubByUrl(routes: Record<string, StubResponse>): {
  client: AxiosInstance;
  calls: string[];
} {
  const calls: string[] = [];
  const client = {
    get: async (url: string) => {
      calls.push(url);
      const res = routes[url];
      if (!res) throw new Error(`stub 에 없는 URL: ${url}`);
      if (res.throws) throw res.throws;
      return {
        data: res.body ?? Buffer.alloc(0),
        status: res.status ?? 200,
        headers: { 'content-type': res.contentType ?? 'application/json' },
      };
    },
  } as unknown as AxiosInstance;
  return { client, calls };
}

function htmlFixture(name: string): StubResponse {
  return {
    body: iconv.encode(fs.readFileSync(path.join(FIXTURES, name), 'utf8'), 'euc-kr'),
    contentType: 'text/html;charset=EUC-KR',
  };
}

function apiJson(closePrice: string): StubResponse {
  return { body: Buffer.from(JSON.stringify({ exchangeInfo: { closePrice } }), 'utf8') };
}

function createScraper(
  client: AxiosInstance,
  apiUrl: string | null | undefined = API_URL,
): NaverJpyScraper {
  return new NaverJpyScraper(
    { url: PAGE_URL, apiUrl, timeoutMs: 5_000, minValid: 100, maxValid: 2_000 },
    { httpClient: client },
  );
}

describe('NaverJpyScraper — JSON API 1순위', () => {
  it('API 가 정상이면 HTML 페이지를 요청하지 않는다', async () => {
    const stub = stubByUrl({
      [API_URL]: apiJson('887.50'),
      [PAGE_URL]: htmlFixture('naver-jpy-sample.html'),
    });
    const result = await createScraper(stub.client).fetchRate();

    expect(result.rate).toBe(887.5);
    expect(result.parser).toBe(STOCK_API_PARSER_NAME);
    // 링크로 노출되는 출처는 사람이 볼 수 있는 페이지여야 한다.
    expect(result.source).toBe(PAGE_URL);
    expect(stub.calls).toEqual([API_URL]);
  });

  it('API 요청이 실패하면 HTML 파서로 폴백한다', async () => {
    const stub = stubByUrl({
      [API_URL]: { throws: Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }) },
      [PAGE_URL]: htmlFixture('naver-jpy-sample.html'),
    });
    const result = await createScraper(stub.client).fetchRate();

    expect(result.rate).toBe(888.97);
    expect(result.parser).not.toBe(STOCK_API_PARSER_NAME);
    expect(stub.calls).toEqual([API_URL, PAGE_URL]);
  });

  it('API 가 HTML(차단/점검 페이지)을 돌려줘도 폴백한다', async () => {
    const stub = stubByUrl({
      [API_URL]: { body: Buffer.from('<html>점검 중</html>'), contentType: 'text/html' },
      [PAGE_URL]: htmlFixture('naver-jpy-sample.html'),
    });
    const result = await createScraper(stub.client).fetchRate();
    expect(result.rate).toBe(888.97);
  });

  it('API 가 5xx 를 돌려주면 폴백한다', async () => {
    const stub = stubByUrl({
      [API_URL]: { status: 503, body: Buffer.from('{}') },
      [PAGE_URL]: htmlFixture('naver-jpy-sample.html'),
    });
    const result = await createScraper(stub.client).fetchRate();
    expect(result.rate).toBe(888.97);
  });

  it('API 와 HTML 이 모두 실패하면 ParseError 를 던진다', async () => {
    const stub = stubByUrl({
      [API_URL]: { body: Buffer.from('{"exchangeInfo":{}}') },
      [PAGE_URL]: htmlFixture('naver-jpy-broken.html'),
    });
    await expect(createScraper(stub.client).fetchRate()).rejects.toBeInstanceOf(ParseError);
  });

  it('API 값이 허용 범위를 벗어나면 폴백하지 않고 RateValidationError 를 던진다', async () => {
    const stub = stubByUrl({
      [API_URL]: apiJson('88750'),
      [PAGE_URL]: htmlFixture('naver-jpy-sample.html'),
    });
    await expect(createScraper(stub.client).fetchRate()).rejects.toBeInstanceOf(
      RateValidationError,
    );
    expect(stub.calls).toEqual([API_URL]);
  });

  it('apiUrl: null 이면 JSON 경로를 건너뛴다', async () => {
    const stub = stubByUrl({ [PAGE_URL]: htmlFixture('naver-jpy-sample.html') });
    const result = await createScraper(stub.client, null).fetchRate();
    expect(result.rate).toBe(888.97);
    expect(stub.calls).toEqual([PAGE_URL]);
  });
});
