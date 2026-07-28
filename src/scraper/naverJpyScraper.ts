import axios, { type AxiosError, type AxiosInstance } from 'axios';
import iconv from 'iconv-lite';
import { HttpFetchError, ParseError, RateValidationError } from '../errors.js';
import { childLogger } from '../logger.js';
import type { ResponseDiagnostics, ScrapeResult } from '../types/exchangeRate.js';
import { nowIso } from '../utils/time.js';
import { parseJpyRate, summarizeAttempts } from './parsers.js';

const log = childLogger('scraper');

/**
 * 일반 브라우저 User-Agent.
 * 네이버는 비표준 UA 에 대해 다른 마크업이나 차단 페이지를 반환할 수 있다.
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

/** 네이버 금융은 EUC-KR 로 응답한다. 헤더가 없을 때의 기본값. */
const FALLBACK_CHARSET = 'euc-kr';

export interface NaverScraperConfig {
  readonly url: string;
  readonly timeoutMs: number;
  readonly minValid: number;
  readonly maxValid: number;
}

export interface NaverScraperDeps {
  /** 테스트에서 axios 를 대체하기 위한 주입 지점. */
  readonly httpClient?: AxiosInstance;
}

/** 응답 charset 을 헤더 -> meta 태그 순으로 판별한다. */
export function detectCharset(contentType: string | undefined, body: Buffer): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? '');
  if (fromHeader?.[1] !== undefined) {
    return fromHeader[1].toLowerCase();
  }

  // 헤더에 없으면 앞부분을 latin1 로 훑어 meta 태그를 찾는다.
  const head = body.subarray(0, 2048).toString('latin1');
  const fromMeta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) ??
    /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head);
  if (fromMeta?.[1] !== undefined) {
    return fromMeta[1].toLowerCase();
  }

  return FALLBACK_CHARSET;
}

/** 바이트를 문자열로 디코딩한다. 지원하지 않는 charset 이면 EUC-KR 로 폴백. */
export function decodeBody(body: Buffer, charset: string): string {
  const normalized = charset.toLowerCase();
  const effective =
    normalized === 'ms949' || normalized === 'cp949' || normalized === 'ks_c_5601-1987'
      ? 'euc-kr'
      : normalized;

  if (iconv.encodingExists(effective)) {
    return iconv.decode(body, effective);
  }
  log.warn({ charset }, '알 수 없는 charset — EUC-KR 로 폴백합니다');
  return iconv.decode(body, FALLBACK_CHARSET);
}

/**
 * 네이버 금융 엔화 상세 페이지 스크레이퍼.
 *
 * 책임:
 *  1. HTTP 요청 (타임아웃 강제, 브라우저 UA)
 *  2. 인코딩 판별 및 디코딩
 *  3. 복수 파서로 환율 추출
 *  4. 유효성 범위 검사
 *
 * 재시도는 이 클래스가 아니라 상위 서비스(exchangeRateService)가 담당한다.
 */
export class NaverJpyScraper {
  readonly #config: NaverScraperConfig;
  readonly #http: AxiosInstance;

  constructor(config: NaverScraperConfig, deps: NaverScraperDeps = {}) {
    this.#config = config;
    this.#http =
      deps.httpClient ??
      axios.create({
        timeout: config.timeoutMs,
        responseType: 'arraybuffer',
        // 4xx/5xx 를 예외가 아닌 응답으로 받아 진단 정보를 남긴 뒤 직접 분류한다.
        validateStatus: () => true,
        maxRedirects: 5,
        decompress: true,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
      });
  }

  get url(): string {
    return this.#config.url;
  }

  /**
   * 환율 1회 수집.
   *
   * @throws {HttpFetchError} 네트워크/타임아웃/HTTP 오류 (재시도 가능 여부는 상태코드로 판단)
   * @throws {ParseError} 모든 파서 실패 (재시도 가능)
   * @throws {RateValidationError} 값이 허용 범위를 벗어남 (재시도 불가)
   */
  async fetchRate(signal?: AbortSignal): Promise<ScrapeResult> {
    const startedAt = Date.now();
    const { body, diagnostics } = await this.#fetchBody(signal);
    const html = decodeBody(body, diagnostics.charset);

    const outcome = parseJpyRate(html, {
      min: this.#config.minValid,
      max: this.#config.maxValid,
    });

    if (!outcome.ok) {
      // 구조 변경 진단 정보 — HTML 본문은 절대 남기지 않는다.
      log.error(
        {
          event: 'rate_parse_failed',
          httpStatus: diagnostics.httpStatus,
          contentType: diagnostics.contentType,
          contentLength: diagnostics.contentLength,
          charset: diagnostics.charset,
          attempts: summarizeAttempts(outcome.attempts),
        },
        '네이버 페이지에서 환율을 찾지 못했습니다 (페이지 구조 변경 가능성)',
      );
      throw new ParseError(`환율 파싱 실패 — 시도한 파서: ${summarizeAttempts(outcome.attempts)}`, {
        attempts: outcome.attempts.map((attempt) => `${attempt.parser}:${attempt.reason ?? 'ok'}`),
      });
    }

    const { value, parser } = outcome;

    if (value < this.#config.minValid || value > this.#config.maxValid) {
      log.error(
        {
          event: 'rate_out_of_range',
          rate: value,
          parser,
          min: this.#config.minValid,
          max: this.#config.maxValid,
          httpStatus: diagnostics.httpStatus,
          contentLength: diagnostics.contentLength,
        },
        '파싱된 환율이 허용 범위를 벗어났습니다 — 저장하지 않습니다',
      );
      throw new RateValidationError(value, this.#config.minValid, this.#config.maxValid);
    }

    log.debug(
      {
        event: 'rate_scraped',
        rate: value,
        parser,
        durationMs: Date.now() - startedAt,
        httpStatus: diagnostics.httpStatus,
        contentLength: diagnostics.contentLength,
        charset: diagnostics.charset,
      },
      '환율 수집 성공',
    );

    return {
      rate: value,
      parser,
      collectedAt: nowIso(),
      source: this.#config.url,
      diagnostics,
    };
  }

  async #fetchBody(
    signal?: AbortSignal,
  ): Promise<{ body: Buffer; diagnostics: ResponseDiagnostics }> {
    let response;
    try {
      response = await this.#http.get<ArrayBuffer>(this.#config.url, {
        timeout: this.#config.timeoutMs,
        responseType: 'arraybuffer',
        signal,
      });
    } catch (error) {
      const axiosError = error as AxiosError;
      const isTimeout = axiosError.code === 'ECONNABORTED' || axiosError.code === 'ETIMEDOUT';
      throw new HttpFetchError(
        isTimeout
          ? `요청이 ${this.#config.timeoutMs}ms 안에 완료되지 않았습니다`
          : `네이버 금융 요청 실패: ${axiosError.code ?? axiosError.message}`,
        { httpStatus: axiosError.response?.status ?? null, retryable: true, cause: error },
      );
    }

    const body = Buffer.from(response.data);
    const contentType = String(response.headers['content-type'] ?? '');
    const diagnostics: ResponseDiagnostics = {
      httpStatus: response.status,
      contentType,
      contentLength: body.byteLength,
      charset: detectCharset(contentType, body),
    };

    if (response.status < 200 || response.status >= 300) {
      log.warn(
        {
          event: 'rate_http_error',
          httpStatus: diagnostics.httpStatus,
          contentType: diagnostics.contentType,
          contentLength: diagnostics.contentLength,
        },
        '네이버 금융이 비정상 상태 코드를 반환했습니다',
      );
      throw new HttpFetchError(`HTTP ${response.status}`, { httpStatus: response.status });
    }

    if (body.byteLength === 0) {
      throw new HttpFetchError('빈 응답 본문', { httpStatus: response.status, retryable: true });
    }

    if (contentType !== '' && !/text\/html|application\/xhtml/i.test(contentType)) {
      // HTML 이 아니면 차단 페이지/점검 페이지일 가능성이 높다.
      log.warn(
        {
          event: 'rate_unexpected_content_type',
          contentType,
          contentLength: diagnostics.contentLength,
        },
        'HTML 이 아닌 응답을 받았습니다',
      );
    }

    return { body, diagnostics };
  }
}
