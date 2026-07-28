import { describe, expect, it } from 'vitest';
import {
  calcChangeAmount,
  calcChangePercent,
  formatRate,
  formatSigned,
  parseNumericText,
  round2,
  trendOf,
  trendSymbol,
} from '../src/utils/money.js';

describe('변화량 계산', () => {
  it('상승분을 계산한다', () => {
    expect(calcChangeAmount(946.32, 945.08)).toBe(1.24);
  });

  it('하락분을 음수로 계산한다', () => {
    expect(calcChangeAmount(945.08, 946.32)).toBe(-1.24);
  });

  it('변화가 없으면 0 이다', () => {
    expect(calcChangeAmount(946.32, 946.32)).toBe(0);
  });

  it('이전 값이 없으면 null 이다', () => {
    expect(calcChangeAmount(946.32, null)).toBeNull();
    expect(calcChangeAmount(946.32, undefined)).toBeNull();
  });

  /**
   * 순수 부동소수점 뺄셈은 946.32 - 945.08 = 1.2399999999999523 이 된다.
   * 정수(1/100 단위) 연산으로 이 오차를 제거해야 한다. (요구사항 20)
   */
  it('부동소수점 오차 없이 정확한 값을 만든다', () => {
    expect(946.32 - 945.08).not.toBe(1.24); // 문제가 실재함을 명시
    expect(calcChangeAmount(946.32, 945.08)).toBe(1.24);

    expect(calcChangeAmount(0.3, 0.1)).toBe(0.2);
    expect(calcChangeAmount(1000.1, 1000.0)).toBe(0.1);
    expect(calcChangeAmount(1046.32, 1046.31)).toBe(0.01);
  });

  it('큰 값에서도 정확하다', () => {
    expect(calcChangeAmount(1999.99, 1000.01)).toBe(999.98);
  });
});

describe('변화율 계산', () => {
  it('상승률을 소수점 둘째 자리로 계산한다', () => {
    // 1.24 / 945.08 * 100 = 0.1312...
    expect(calcChangePercent(946.32, 945.08)).toBe(0.13);
  });

  it('하락률은 음수다', () => {
    expect(calcChangePercent(945.08, 946.32)).toBe(-0.13);
  });

  it('변화가 없으면 0 이다', () => {
    expect(calcChangePercent(946.32, 946.32)).toBe(0);
  });

  it('이전 값이 0 이면 (0 나누기 방지) null 이다', () => {
    expect(calcChangePercent(946.32, 0)).toBeNull();
  });

  it('이전 값이 없으면 null 이다', () => {
    expect(calcChangePercent(946.32, null)).toBeNull();
  });

  it('실제 시나리오: 888.97 -> 895.21', () => {
    expect(calcChangeAmount(895.21, 888.97)).toBe(6.24);
    expect(calcChangePercent(895.21, 888.97)).toBe(0.7);
  });
});

describe('반올림 및 포맷', () => {
  it('소수점 둘째 자리로 반올림한다', () => {
    expect(round2(946.324)).toBe(946.32);
    expect(round2(946.325)).toBe(946.33);
    expect(round2(946.3)).toBe(946.3);
  });

  it('환율은 항상 두 자리로 표시한다', () => {
    expect(formatRate(946.3)).toBe('946.30');
    expect(formatRate(946)).toBe('946.00');
    expect(formatRate(1046.325)).toBe('1046.33');
  });

  it('부호를 항상 표시한다', () => {
    expect(formatSigned(1.24)).toBe('+1.24');
    expect(formatSigned(-1.24)).toBe('-1.24');
    expect(formatSigned(0)).toBe('0.00');
  });
});

describe('추세 판정', () => {
  it('상승은 ▲', () => {
    expect(trendSymbol(trendOf(1.24))).toBe('▲');
  });

  it('하락은 ▼', () => {
    expect(trendSymbol(trendOf(-1.24))).toBe('▼');
  });

  it('동일은 ―', () => {
    expect(trendSymbol(trendOf(0))).toBe('―');
    expect(trendSymbol(trendOf(null))).toBe('―');
  });

  it('0.001 처럼 표시상 0인 값은 보합으로 본다', () => {
    expect(trendOf(0.001)).toBe('flat');
    expect(trendOf(0.01)).toBe('up');
  });
});

describe('숫자 텍스트 파싱', () => {
  it('쉼표를 제거하고 숫자로 만든다', () => {
    expect(parseNumericText('1,046.32')).toBe(1046.32);
    expect(parseNumericText('1,234,567.89')).toBe(1234567.89);
  });

  it('단위 문자와 공백을 무시한다', () => {
    expect(parseNumericText('  946.32 원  ')).toBe(946.32);
    expect(parseNumericText('\n888.97원\n')).toBe(888.97);
  });

  it('전각 공백도 제거한다', () => {
    expect(parseNumericText('946.32　원')).toBe(946.32);
  });

  it('숫자가 없으면 null', () => {
    expect(parseNumericText('점검 중입니다')).toBeNull();
    expect(parseNumericText('')).toBeNull();
  });
});
