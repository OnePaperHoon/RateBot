import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';

/**
 * 시간 유틸.
 *
 * 규칙:
 *  - 저장 및 내부 전달: ISO 8601 UTC (`2026-07-29T14:45:00.000Z`)
 *  - 화면 표시: Asia/Seoul
 *  - "당일" 판정: Asia/Seoul 달력 날짜 기준
 */

export const DISPLAY_TIME_ZONE = 'Asia/Seoul';

/** 현재 시각을 ISO 8601 UTC 로 반환. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** ISO 문자열 -> Date. 잘못된 값이면 null. */
export function parseIso(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 화면 표시용: `2026-07-29 23:45:00 KST` */
export function formatSeoul(isoOrDate: string | Date, pattern = 'yyyy-MM-dd HH:mm:ss'): string {
  const date = typeof isoOrDate === 'string' ? parseIso(isoOrDate) : isoOrDate;
  if (!date) return '(알 수 없음)';
  return `${formatInTimeZone(date, DISPLAY_TIME_ZONE, pattern)} KST`;
}

/** 화면 표시용 짧은 형식: `07-29 23:45` */
export function formatSeoulShort(isoOrDate: string | Date): string {
  const date = typeof isoOrDate === 'string' ? parseIso(isoOrDate) : isoOrDate;
  if (!date) return '(알 수 없음)';
  return formatInTimeZone(date, DISPLAY_TIME_ZONE, 'MM-dd HH:mm');
}

/** Asia/Seoul 기준 달력 날짜 키 (`2026-07-29`). */
export function seoulDayKey(isoOrDate: string | Date = new Date()): string {
  const date = typeof isoOrDate === 'string' ? parseIso(isoOrDate) : isoOrDate;
  if (!date) return formatInTimeZone(new Date(), DISPLAY_TIME_ZONE, 'yyyy-MM-dd');
  return formatInTimeZone(date, DISPLAY_TIME_ZONE, 'yyyy-MM-dd');
}

/**
 * Asia/Seoul 기준 하루의 시작/끝을 UTC ISO 문자열로 반환한다.
 * SQLite 의 `collected_at BETWEEN ? AND ?` 조회에 사용한다.
 */
export function seoulDayBoundsUtc(isoOrDate: string | Date = new Date()): {
  startIso: string;
  endIso: string;
  dayKey: string;
} {
  const dayKey = seoulDayKey(isoOrDate);
  // "2026-07-29T00:00:00" 을 Asia/Seoul 로 해석하여 UTC 순간으로 변환
  const start = fromZonedTime(`${dayKey}T00:00:00.000`, DISPLAY_TIME_ZONE);
  const end = fromZonedTime(`${dayKey}T23:59:59.999`, DISPLAY_TIME_ZONE);
  return { startIso: start.toISOString(), endIso: end.toISOString(), dayKey };
}

/** 두 ISO 시각이 Asia/Seoul 기준 같은 날인가. */
export function isSameSeoulDay(a: string | Date, b: string | Date): boolean {
  return seoulDayKey(a) === seoulDayKey(b);
}

/** Asia/Seoul 로컬 시간으로 본 Date (표시 계산 보조). */
export function toSeoulDate(isoOrDate: string | Date): Date {
  const date = typeof isoOrDate === 'string' ? (parseIso(isoOrDate) ?? new Date()) : isoOrDate;
  return toZonedTime(date, DISPLAY_TIME_ZONE);
}

/** Discord 동적 타임스탬프 마크업. `R`=상대시간, `f`=날짜+시각 */
export function discordTimestamp(isoOrDate: string | Date, style: 'R' | 'f' | 'F' | 'T' = 'R') {
  const date = typeof isoOrDate === 'string' ? parseIso(isoOrDate) : isoOrDate;
  if (!date) return '(알 수 없음)';
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

/** N분 전 시각의 ISO 문자열. */
export function isoMinutesAgo(minutes: number, from: Date = new Date()): string {
  return new Date(from.getTime() - minutes * 60_000).toISOString();
}

/** N일 전 시각의 ISO 문자열. */
export function isoDaysAgo(days: number, from: Date = new Date()): string {
  return new Date(from.getTime() - days * 86_400_000).toISOString();
}

/** 두 시각의 차이가 threshold(분)를 초과하는가 = 데이터가 오래됐는가. */
export function isStale(collectedAtIso: string, staleAfterMinutes: number, now = new Date()) {
  const collected = parseIso(collectedAtIso);
  if (!collected) return true;
  return now.getTime() - collected.getTime() > staleAfterMinutes * 60_000;
}

/** 밀리초 -> `3일 4시간 5분 6초` 형태의 가동 시간 문자열. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '알 수 없음';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}일`);
  if (hours > 0) parts.push(`${hours}시간`);
  if (minutes > 0) parts.push(`${minutes}분`);
  if (parts.length === 0 || seconds > 0) parts.push(`${seconds}초`);
  return parts.join(' ');
}
