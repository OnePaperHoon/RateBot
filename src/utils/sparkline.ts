/**
 * 텍스트 스파크라인.
 *
 * Discord Embed 는 이미지 첨부 없이도 추세를 보여줄 수 있어야 하므로
 * 유니코드 블록 문자로 미니 차트를 만든다.
 */

export const SPARK_TICKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

export interface SparklineOptions {
  /** 출력 최대 길이. 입력이 길면 균등 다운샘플링한다. */
  readonly maxWidth?: number;
  /** 값이 모두 같을 때 사용할 문자. */
  readonly flatTick?: string;
}

/**
 * 숫자 배열을 스파크라인 문자열로 변환한다.
 * - 빈 배열 -> 빈 문자열
 * - 모든 값이 동일 -> 중간 높이 문자로 채움
 * - 유한하지 않은 값은 제거
 */
export function sparkline(values: readonly number[], options: SparklineOptions = {}): string {
  const maxWidth = options.maxWidth ?? 24;
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return '';

  const sampled = downsample(finite, maxWidth);
  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const span = max - min;

  if (span === 0) {
    const flat = options.flatTick ?? SPARK_TICKS[3];
    return flat.repeat(sampled.length);
  }

  const lastIndex = SPARK_TICKS.length - 1;
  return sampled
    .map((value) => {
      const ratio = (value - min) / span;
      const index = Math.round(ratio * lastIndex);
      const clamped = Math.min(lastIndex, Math.max(0, index));
      return SPARK_TICKS[clamped] ?? SPARK_TICKS[0];
    })
    .join('');
}

/**
 * 배열을 목표 길이로 균등 다운샘플링한다.
 * 구간 평균을 사용해 스파이크가 사라지지 않도록 처음/마지막 값은 보존한다.
 */
export function downsample(values: readonly number[], targetLength: number): number[] {
  if (targetLength <= 0) return [];
  if (values.length <= targetLength) return [...values];

  const result: number[] = [];
  const bucketSize = values.length / targetLength;

  for (let i = 0; i < targetLength; i += 1) {
    const start = Math.floor(i * bucketSize);
    const end = Math.min(values.length, Math.max(start + 1, Math.floor((i + 1) * bucketSize)));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      const value = values[j];
      if (value !== undefined) {
        sum += value;
        count += 1;
      }
    }
    result.push(count > 0 ? sum / count : (values[start] ?? 0));
  }

  // 양 끝 값은 원본을 그대로 유지 (시작/종료 환율이 그래프와 어긋나지 않도록)
  const first = values[0];
  const last = values[values.length - 1];
  if (first !== undefined) result[0] = first;
  if (last !== undefined) result[result.length - 1] = last;

  return result;
}
