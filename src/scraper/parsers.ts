import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { parseNumericText, round2 } from '../utils/money.js';

/**
 * 네이버 금융 엔화 상세 페이지 파서 모음.
 *
 * 설계 원칙 (요구사항 2):
 *  - 단일 CSS 선택자를 신뢰하지 않는다. 서로 독립적인 전략을 순서대로 시도한다.
 *  - 마지막 전략은 DOM 에 의존하지 않는 정규식이라, 클래스명이 바뀌어도 살아남는다.
 *  - 어떤 파서가 값을 찾았는지 항상 기록한다 (구조 변경 조기 감지).
 *
 * 실제 마크업(2026-07 기준):
 *
 *   <p class="no_today">
 *     <em class="no_down">
 *       <em class="no_down">
 *         <span class="no8">8</span><span class="no8">8</span><span class="no8">8</span>
 *         <span class="jum">.</span><span class="no9">9</span><span class="no7">7</span>
 *       </em>
 *     </em>
 *     <span class="txt_won">원</span>
 *   </p>
 *
 * 엔화는 네이버에서도 "100엔 당 원" 으로 고시되므로 no_today 값이 곧 100 JPY 기준이다.
 */

/** 개별 파서가 반환하는 값. 찾지 못하면 null. */
export interface ParserOutput {
  /** 파싱된 숫자 (아직 100 JPY 정규화 전일 수 있음). */
  readonly value: number;
  /** 이 값이 1 JPY 당 가격이면 곱해야 할 배수. 보통 1 또는 100. */
  readonly unitMultiplier: number;
}

export interface RateParser {
  readonly name: string;
  /** 값을 찾으면 ParserOutput, 못 찾으면 null. 예외를 던지지 않는다. */
  parse(html: string, $: CheerioAPI): ParserOutput | null;
}

/** 파싱 시도 기록 (진단 로그용). */
export interface ParseAttempt {
  readonly parser: string;
  readonly ok: boolean;
  readonly reason?: string;
  readonly rawValue?: number;
}

export interface ParseSuccess {
  readonly ok: true;
  readonly value: number;
  readonly parser: string;
  readonly attempts: readonly ParseAttempt[];
}

export interface ParseFailure {
  readonly ok: false;
  readonly attempts: readonly ParseAttempt[];
}

export type ParseOutcome = ParseSuccess | ParseFailure;

/** `no8` -> 8, `jum` -> '.' 매핑에 사용하는 정규식. */
const DIGIT_CLASS_RE = /(?:^|\s)no(\d)(?:\s|$)/;

/**
 * 파서 1 — `.no_today` 요소의 텍스트.
 * 가장 단순하고, 현재 마크업에서 항상 동작한다.
 * (digit span 안에 실제 텍스트 노드가 들어 있으므로 .text() 로 "888.97원" 이 나온다.)
 */
const noTodayText: RateParser = {
  name: 'no_today_text',
  parse(_html, $) {
    const node = $('.no_today').first();
    if (node.length === 0) return null;
    // '원' 등 단위 문자는 parseNumericText 가 무시한다.
    const value = parseNumericText(node.text());
    if (value === null || value <= 0) return null;
    return { value, unitMultiplier: 1 };
  },
};

/**
 * 파서 2 — `.no_today` 하위 digit span 의 **클래스명**으로 숫자를 재조립.
 * 텍스트 노드가 제거되고 CSS 스프라이트로만 렌더링되는 변형에 대비한다.
 */
const noTodayDigitClasses: RateParser = {
  name: 'no_today_digit_classes',
  parse(_html, $) {
    const container = $('.no_today').first();
    if (container.length === 0) return null;

    let assembled = '';
    container.find('span').each((_index, element) => {
      const className = $(element).attr('class') ?? '';
      if (className.includes('jum')) {
        assembled += '.';
        return;
      }
      const match = DIGIT_CLASS_RE.exec(className);
      if (match?.[1] !== undefined) {
        assembled += match[1];
      }
    });

    if (assembled === '' || !/^\d+(?:\.\d+)?$/.test(assembled)) return null;
    const value = Number(assembled);
    if (!Number.isFinite(value) || value <= 0) return null;
    return { value, unitMultiplier: 1 };
  },
};

/**
 * 파서 3 — 접근성용 `.blind` 텍스트.
 * 과거 레이아웃 및 일부 페이지 변형에서 사용된다.
 */
const blindText: RateParser = {
  name: 'blind_text',
  parse(_html, $) {
    const candidates = $('.no_today .blind, .today .blind, .head_info .blind');
    let found: number | null = null;
    candidates.each((_index, element) => {
      if (found !== null) return;
      const value = parseNumericText($(element).text());
      if (value !== null && value > 0) found = value;
    });
    return found === null ? null : { value: found, unitMultiplier: 1 };
  },
};

/**
 * 파서 4 — 환율계산기 `<option>` 의 value/label 속성.
 * 화면 표시용 마크업과 완전히 독립된 데이터 경로라, 상단 레이아웃이 바뀌어도 살아남는다.
 *
 *   <option value="8.8897" label="100" selected="selected"> 일본 엔 JPY</option>
 *   -> 1 JPY = 8.8897 KRW, 고시 단위 100 -> 100 JPY = 888.97 KRW
 */
const calculatorOption: RateParser = {
  name: 'calculator_option_jpy',
  parse(_html, $) {
    let result: ParserOutput | null = null;

    $('option').each((_index, element) => {
      if (result !== null) return;
      const node = $(element);
      const text = node.text();
      if (!text.includes('JPY')) return;

      const value = parseNumericText(node.attr('value') ?? '');
      if (value === null || value <= 0) return;

      const labelRaw = node.attr('label');
      const label = labelRaw === undefined ? null : parseNumericText(labelRaw);
      const unitMultiplier = label !== null && label > 0 ? label : 1;

      result = { value, unitMultiplier };
    });

    return result;
  },
};

/**
 * 파서 5 — DOM 을 쓰지 않는 정규식 폴백.
 * `no_today` 블록의 원문에서 digit span 클래스 시퀀스를 직접 읽는다.
 * cheerio 가 파싱하지 못할 정도로 HTML 이 깨진 경우에도 동작한다.
 */
const noTodayRegex: RateParser = {
  name: 'no_today_regex',
  parse(html) {
    const blockMatch = /class=["']no_today["'][\s\S]{0,1500}?<\/p>/i.exec(html);
    if (!blockMatch) return null;
    const block = blockMatch[0];

    let assembled = '';
    const tokenRe = /<span[^>]*class=["'][^"']*?\b(no(\d)|jum)\b[^"']*["'][^>]*>/gi;
    let token: RegExpExecArray | null = tokenRe.exec(block);
    while (token !== null) {
      assembled += token[2] !== undefined ? token[2] : '.';
      token = tokenRe.exec(block);
    }

    if (/^\d+(?:\.\d+)?$/.test(assembled)) {
      const value = Number(assembled);
      if (Number.isFinite(value) && value > 0) return { value, unitMultiplier: 1 };
    }

    // digit span 이 없다면 블록 안의 일반 텍스트에서 숫자를 찾는다 (쉼표 허용).
    const plain = block.replace(/<[^>]+>/g, ' ');
    const textMatch = /(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/.exec(plain);
    if (textMatch?.[1] !== undefined) {
      const value = parseNumericText(textMatch[1]);
      if (value !== null && value > 0) return { value, unitMultiplier: 1 };
    }

    return null;
  },
};

/**
 * 파서 6 — 목록 페이지(`exchangeList.naver`) 형태 폴백.
 * URL 을 목록 페이지로 바꿔 운영하는 경우를 지원한다.
 */
const exchangeListRow: RateParser = {
  name: 'exchange_list_row',
  parse(_html, $) {
    let result: ParserOutput | null = null;

    $('table tr').each((_index, element) => {
      if (result !== null) return;
      const row = $(element);
      const title = row.find('td.tit, th').first().text();
      if (!title.includes('일본') && !title.includes('JPY')) return;

      const cell = row.find('td.sale, td.num').first();
      const value = parseNumericText(cell.text());
      if (value === null || value <= 0) return;

      // 목록 페이지는 제목에 "일본 JPY (100엔)" 처럼 단위를 표기한다.
      const unitMatch = /(\d+)\s*엔/.exec(title);
      const unit = unitMatch?.[1] !== undefined ? Number(unitMatch[1]) : 1;
      result = { value, unitMultiplier: unit > 0 && unit !== 100 ? 100 / unit : 1 };
    });

    return result;
  },
};

/** 시도 순서. 앞쪽일수록 신뢰도가 높다. */
export const RATE_PARSERS: readonly RateParser[] = [
  noTodayText,
  noTodayDigitClasses,
  blindText,
  calculatorOption,
  noTodayRegex,
  exchangeListRow,
];

/**
 * 값을 "100 JPY 당 KRW" 로 정규화한다.
 *
 * 네이버가 1엔 기준 값을 노출하는 경로(계산기 option 등)를 대비한 안전장치다.
 * 명시적인 `unitMultiplier` 를 우선하고, 그래도 범위를 벗어나면 ×100 을 한 번 시도한다.
 */
export function normalizeToPer100(
  output: ParserOutput,
  bounds: { min: number; max: number },
): number | null {
  const scaled = round2(output.value * output.unitMultiplier);
  if (scaled >= bounds.min && scaled <= bounds.max) return scaled;

  // 1 JPY 당 가격으로 보이는 경우 (예: 8.89) 100 배 해본다.
  const per100 = round2(output.value * 100);
  if (output.unitMultiplier === 1 && per100 >= bounds.min && per100 <= bounds.max) {
    return per100;
  }

  // 정규화로 구제되지 않으면 원래 스케일 값을 그대로 돌려주고
  // 유효성 검사 단계에서 명확하게 거부되도록 한다.
  return scaled;
}

/**
 * 모든 파서를 순서대로 시도한다.
 *
 * @param bounds 정규화 판단에 사용할 허용 범위. 최종 유효성 검사는 스크레이퍼가 수행한다.
 */
export function parseJpyRate(html: string, bounds: { min: number; max: number }): ParseOutcome {
  const attempts: ParseAttempt[] = [];

  let $: CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch (error) {
    // cheerio 가 실패해도 정규식 파서는 시도할 수 있도록 빈 문서를 사용한다.
    attempts.push({
      parser: 'cheerio_load',
      ok: false,
      reason: error instanceof Error ? error.message : 'HTML 로드 실패',
    });
    $ = cheerio.load('<html></html>');
  }

  for (const parser of RATE_PARSERS) {
    let output: ParserOutput | null = null;
    try {
      output = parser.parse(html, $);
    } catch (error) {
      attempts.push({
        parser: parser.name,
        ok: false,
        reason: error instanceof Error ? error.message : '파서 예외',
      });
      continue;
    }

    if (output === null) {
      attempts.push({ parser: parser.name, ok: false, reason: '값을 찾지 못함' });
      continue;
    }

    const normalized = normalizeToPer100(output, bounds);
    if (normalized === null || !Number.isFinite(normalized) || normalized <= 0) {
      attempts.push({
        parser: parser.name,
        ok: false,
        reason: '정규화 실패',
        rawValue: output.value,
      });
      continue;
    }

    attempts.push({ parser: parser.name, ok: true, rawValue: normalized });
    return { ok: true, value: normalized, parser: parser.name, attempts };
  }

  return { ok: false, attempts };
}

/** 진단 로그용 한 줄 요약. HTML 본문은 포함하지 않는다. */
export function summarizeAttempts(attempts: readonly ParseAttempt[]): string {
  return attempts
    .map((attempt) => `${attempt.parser}=${attempt.ok ? 'ok' : (attempt.reason ?? 'fail')}`)
    .join(', ');
}
