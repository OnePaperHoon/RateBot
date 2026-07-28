import { describe, expect, it } from 'vitest';
import { SPARK_TICKS, downsample, sparkline } from '../src/utils/sparkline.js';

describe('sparkline', () => {
  it('빈 배열은 빈 문자열을 만든다', () => {
    expect(sparkline([])).toBe('');
  });

  it('값 개수만큼 문자를 만든다', () => {
    expect(sparkline([1, 2, 3, 4, 5])).toHaveLength(5);
  });

  it('최소값은 가장 낮은 블록, 최대값은 가장 높은 블록이 된다', () => {
    const result = sparkline([1, 5, 10]);
    expect(result[0]).toBe(SPARK_TICKS[0]);
    expect(result[2]).toBe(SPARK_TICKS[SPARK_TICKS.length - 1]);
  });

  it('상승 추세는 단조 증가하는 높이로 표현된다', () => {
    const result = sparkline([940, 942, 944, 946, 948]);
    const heights = [...result].map((char) =>
      SPARK_TICKS.indexOf(char as (typeof SPARK_TICKS)[number]),
    );
    for (let i = 1; i < heights.length; i += 1) {
      expect(heights[i]!).toBeGreaterThanOrEqual(heights[i - 1]!);
    }
  });

  it('하락 추세는 단조 감소하는 높이로 표현된다', () => {
    const result = sparkline([948, 946, 944, 942, 940]);
    const heights = [...result].map((char) =>
      SPARK_TICKS.indexOf(char as (typeof SPARK_TICKS)[number]),
    );
    for (let i = 1; i < heights.length; i += 1) {
      expect(heights[i]!).toBeLessThanOrEqual(heights[i - 1]!);
    }
  });

  it('모든 값이 같으면 0으로 나누지 않고 평탄한 선을 만든다', () => {
    const result = sparkline([946.32, 946.32, 946.32]);
    expect(result).toBe(`${SPARK_TICKS[3]}${SPARK_TICKS[3]}${SPARK_TICKS[3]}`);
  });

  it('maxWidth 를 넘으면 다운샘플링한다', () => {
    const values = Array.from({ length: 1_440 }, (_, index) => 940 + Math.sin(index / 40) * 5);
    expect(sparkline(values, { maxWidth: 24 })).toHaveLength(24);
  });

  it('유한하지 않은 값은 무시한다', () => {
    expect(sparkline([1, Number.NaN, 3, Number.POSITIVE_INFINITY])).toHaveLength(2);
  });

  it('실제 환율 시계열로 그럴듯한 그래프를 만든다', () => {
    const rates = [942.8, 943.1, 944.5, 946.32, 945.9, 949.1, 947.2];
    const result = sparkline(rates);
    expect(result).toHaveLength(7);
    // 최고가(949.10) 위치가 가장 높은 블록이어야 한다
    expect(result[5]).toBe(SPARK_TICKS[SPARK_TICKS.length - 1]);
  });
});

describe('downsample', () => {
  it('목표 길이보다 짧으면 원본을 그대로 반환한다', () => {
    expect(downsample([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  it('목표 길이로 줄인다', () => {
    expect(downsample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5)).toHaveLength(5);
  });

  it('처음과 마지막 값은 보존한다', () => {
    const values = Array.from({ length: 100 }, (_, index) => index);
    const result = downsample(values, 10);
    expect(result[0]).toBe(0);
    expect(result[result.length - 1]).toBe(99);
  });

  it('목표 길이가 0 이하면 빈 배열', () => {
    expect(downsample([1, 2, 3], 0)).toEqual([]);
  });
});
