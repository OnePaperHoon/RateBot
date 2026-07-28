/**
 * 환율 도메인 타입.
 *
 * 시간 규칙:
 *  - 저장/전달되는 모든 시각 문자열은 ISO 8601 UTC(`...Z`) 형식이다.
 *  - Asia/Seoul 변환은 화면 표시 단계에서만 수행한다. (utils/time.ts)
 *
 * 단위 규칙:
 *  - `rate` 는 항상 "100 JPY 당 KRW" 이다.
 */

/** 스크레이퍼가 반환하는 원시 수집 결과. */
export interface ScrapeResult {
  /** 100 JPY 당 KRW. 소수점 둘째 자리로 반올림됨. */
  readonly rate: number;
  /** 값을 찾아낸 파서 이름 (진단/로그용). */
  readonly parser: string;
  /** 수집 시각 (ISO 8601 UTC). */
  readonly collectedAt: string;
  /** 출처 URL. */
  readonly source: string;
  /** HTTP 응답 진단 정보. */
  readonly diagnostics: ResponseDiagnostics;
}

/** HTML 응답 진단 정보. 본문 자체는 절대 포함하지 않는다. */
export interface ResponseDiagnostics {
  readonly httpStatus: number;
  readonly contentType: string;
  readonly contentLength: number;
  readonly charset: string;
}

/** rates 테이블 1행. */
export interface RateRecord {
  readonly id: number;
  readonly rate: number;
  readonly changeAmount: number | null;
  readonly changePercent: number | null;
  readonly collectedAt: string;
  readonly source: string;
  readonly createdAt: string;
}

/** 저장 직전의 신규 환율 데이터. */
export interface NewRate {
  readonly rate: number;
  readonly changeAmount: number | null;
  readonly changePercent: number | null;
  readonly collectedAt: string;
  readonly source: string;
}

/**
 * Discord / Notion 표시에 필요한 완성된 스냅샷.
 * SQLite 저장이 끝난 뒤 조립된다.
 */
export interface RateSnapshot {
  readonly rate: number;
  readonly changeAmount: number | null;
  readonly changePercent: number | null;
  /** 당일(Asia/Seoul 기준) 최고가. */
  readonly dailyHigh: number;
  /** 당일(Asia/Seoul 기준) 최저가. */
  readonly dailyLow: number;
  readonly collectedAt: string;
  readonly source: string;
}

/** 기간 통계 (/yen-history). */
export interface RangeStats {
  readonly periodLabel: string;
  readonly openRate: number;
  readonly closeRate: number;
  readonly high: number;
  readonly low: number;
  readonly changeAmount: number;
  readonly changePercent: number;
  readonly dataPoints: number;
  /** 스파크라인 생성을 위한 다운샘플된 시계열. */
  readonly series: readonly number[];
  readonly firstAt: string;
  readonly lastAt: string;
}

/** 수집 시도의 결과. */
export type CollectionOutcome =
  | { readonly status: 'success'; readonly snapshot: RateSnapshot; readonly durationMs: number }
  | { readonly status: 'failed'; readonly error: Error; readonly durationMs: number }
  | { readonly status: 'skipped'; readonly reason: string };

/** 수집 트리거 출처. */
export type CollectionTrigger = 'startup' | 'schedule' | 'manual';

/** health_events.level */
export type HealthLevel = 'info' | 'warn' | 'error';

/** health_events.component */
export type HealthComponent = 'scraper' | 'discord' | 'notion' | 'database' | 'scheduler' | 'app';
