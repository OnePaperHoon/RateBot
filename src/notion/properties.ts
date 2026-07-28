import type { CreatePageParameters, UpdatePageParameters } from '@notionhq/client';
import type { RateSnapshot } from '../types/exchangeRate.js';
import { round2 } from '../utils/money.js';
import { STATUS_ERROR, STATUS_OK } from './schema.js';

/**
 * Notion 속성 값 빌더.
 *
 * SDK 의 속성 union 타입은 매우 넓어서 그대로 다루면 가독성이 떨어진다.
 * 여기서 우리가 실제로 쓰는 5가지 타입만 정의하고, API 호출 경계에서 한 번만 변환한다.
 * (`any` 를 쓰지 않고 타입 안전성을 유지하기 위한 의도적인 경계)
 */

export type NotionPropertyValue =
  | { readonly title: ReadonlyArray<{ readonly text: { readonly content: string } }> }
  | { readonly number: number | null }
  | { readonly date: { readonly start: string } | null }
  | { readonly select: { readonly name: string } | null }
  | { readonly url: string | null };

export type NotionPropertyMap = Record<string, NotionPropertyValue>;

export function titleValue(content: string): NotionPropertyValue {
  return { title: [{ text: { content } }] };
}

export function numberValue(value: number | null | undefined): NotionPropertyValue {
  if (value === null || value === undefined || !Number.isFinite(value)) return { number: null };
  return { number: round2(value) };
}

export function dateValue(isoString: string | null | undefined): NotionPropertyValue {
  if (!isoString) return { date: null };
  return { date: { start: isoString } };
}

export function selectValue(name: string | null): NotionPropertyValue {
  return name === null ? { select: null } : { select: { name } };
}

export function urlValue(url: string | null | undefined): NotionPropertyValue {
  return { url: url && url.length > 0 ? url : null };
}

/** 상태 페이지 속성 집합. */
export function buildStatusProperties(
  snapshot: RateSnapshot,
  options: { readonly healthy: boolean; readonly title?: string },
): NotionPropertyMap {
  return {
    Name: titleValue(options.title ?? 'YenWatch'),
    Rate: numberValue(snapshot.rate),
    Change: numberValue(snapshot.changeAmount),
    'Change Percent': numberValue(snapshot.changePercent),
    'Daily High': numberValue(snapshot.dailyHigh),
    'Daily Low': numberValue(snapshot.dailyLow),
    'Collected At': dateValue(snapshot.collectedAt),
    Status: selectValue(options.healthy ? STATUS_OK : STATUS_ERROR),
    Source: urlValue(snapshot.source),
  };
}

/** 이력 행 속성 집합 (Status 제외). */
export function buildHistoryProperties(snapshot: RateSnapshot, title: string): NotionPropertyMap {
  return {
    Name: titleValue(title),
    Rate: numberValue(snapshot.rate),
    Change: numberValue(snapshot.changeAmount),
    'Change Percent': numberValue(snapshot.changePercent),
    'Daily High': numberValue(snapshot.dailyHigh),
    'Daily Low': numberValue(snapshot.dailyLow),
    'Collected At': dateValue(snapshot.collectedAt),
    Source: urlValue(snapshot.source),
  };
}

/**
 * SDK 파라미터 타입으로 변환하는 유일한 지점.
 * 위 빌더들이 스키마와 일치하는 값만 만들도록 보장하므로 여기서만 좁힌다.
 */
export function toCreateProperties(map: NotionPropertyMap): CreatePageParameters['properties'] {
  return map as unknown as CreatePageParameters['properties'];
}

export function toUpdateProperties(map: NotionPropertyMap): UpdatePageParameters['properties'] {
  return map as unknown as UpdatePageParameters['properties'];
}
