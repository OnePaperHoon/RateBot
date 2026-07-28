/**
 * 금액 계산 유틸.
 *
 * 환율은 소수점 둘째 자리까지만 의미가 있으므로, 모든 계산을
 * "정수 센트(1/100 단위)" 로 변환해 수행하여 부동소수점 오차 누적을 막는다.
 *
 *   946.32 - 945.08 = 1.2399999999999523  (순수 float)
 *   94632  -  94508 = 124 -> 1.24         (정수 연산)
 */

/** 소수점 둘째 자리로 반올림. 은행가 반올림이 아닌 일반 반올림(HALF_UP). */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return Number.NaN;
  // Number.EPSILON 보정으로 1.005 -> 1.00 같은 이진 표현 오차를 완화한다.
  const scaled = value * 100;
  const rounded = Math.round(scaled + (Math.sign(scaled) * Number.EPSILON * Math.abs(scaled)) / 2);
  return rounded / 100;
}

/** 소수점 N자리로 반올림. */
export function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value)) return Number.NaN;
  const factor = 10 ** digits;
  const scaled = value * factor;
  return Math.round(scaled + (Math.sign(scaled) * Number.EPSILON * Math.abs(scaled)) / 2) / factor;
}

/** 금액을 1/100 단위 정수로 변환. */
export function toCents(value: number): number {
  return Math.round(round2(value) * 100);
}

/** 1/100 단위 정수를 금액으로 변환. */
export function fromCents(cents: number): number {
  return cents / 100;
}

/** 변화량 = 현재 - 이전. 정수 연산으로 오차를 제거한다. */
export function calcChangeAmount(
  current: number,
  previous: number | null | undefined,
): number | null {
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return null;
  if (!Number.isFinite(current)) return null;
  return fromCents(toCents(current) - toCents(previous));
}

/** 변화율(%) = (현재 - 이전) / 이전 * 100. 소수점 둘째 자리. */
export function calcChangePercent(
  current: number,
  previous: number | null | undefined,
): number | null {
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return null;
  if (previous === 0 || !Number.isFinite(current)) return null;
  const diff = toCents(current) - toCents(previous);
  return round2((diff / toCents(previous)) * 100);
}

/** `946.32` 형태의 고정 소수점 문자열. */
export function formatRate(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return round2(value).toFixed(2);
}

/** `+1.24` / `-0.50` / `0.00` — 부호를 항상 표기. */
export function formatSigned(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = roundTo(value, digits);
  const sign = rounded > 0 ? '+' : rounded < 0 ? '-' : '';
  return `${sign}${Math.abs(rounded).toFixed(digits)}`;
}

/** 상승/하락/보합 방향. */
export type TrendDirection = 'up' | 'down' | 'flat';

export function trendOf(changeAmount: number | null | undefined): TrendDirection {
  if (changeAmount === null || changeAmount === undefined || !Number.isFinite(changeAmount)) {
    return 'flat';
  }
  const cents = toCents(changeAmount);
  if (cents > 0) return 'up';
  if (cents < 0) return 'down';
  return 'flat';
}

/** 방향 기호: 상승 ▲ / 하락 ▼ / 동일 ― */
export function trendSymbol(direction: TrendDirection): string {
  switch (direction) {
    case 'up':
      return '▲';
    case 'down':
      return '▼';
    case 'flat':
      return '―';
  }
}

/** 쉼표가 포함된 숫자 문자열 -> number. 실패 시 null. */
export function parseNumericText(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  // 공백/쉼표/전각공백(U+3000)/줄바꿈 제거 후 첫 번째 숫자 토큰 추출
  const cleaned = raw.replace(/[\s\u3000,]/g, '');
  const match = /-?\d+(?:\.\d+)?/.exec(cleaned);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}
