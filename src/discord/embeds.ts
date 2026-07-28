import { EmbedBuilder } from 'discord.js';
import type { AlertDirection, RateAlert } from '../database/alertRepository.js';
import type { RangeStats, RateSnapshot } from '../types/exchangeRate.js';
import type { HealthSnapshot } from '../services/healthService.js';
import {
  formatRate,
  formatSigned,
  trendOf,
  trendSymbol,
  type TrendDirection,
} from '../utils/money.js';
import { sparkline } from '../utils/sparkline.js';
import { discordTimestamp, formatDuration, formatSeoul, isStale } from '../utils/time.js';
import { APP_VERSION } from '../version.js';

/**
 * Discord Embed 생성.
 *
 * 순수 함수로 유지해 테스트 가능하게 한다 (Discord 클라이언트에 의존하지 않음).
 */

const COLOR_UP = 0xe74c3c; // 상승 = 빨강 (한국 증시 관례)
const COLOR_DOWN = 0x3498db; // 하락 = 파랑
const COLOR_FLAT = 0x95a5a6;
const COLOR_STALE = 0xf39c12;
const COLOR_ERROR = 0xc0392b;
const COLOR_OK = 0x2ecc71;

const SOURCE_NAME = '네이버 금융';

function trendColor(direction: TrendDirection): number {
  switch (direction) {
    case 'up':
      return COLOR_UP;
    case 'down':
      return COLOR_DOWN;
    case 'flat':
      return COLOR_FLAT;
  }
}

/** `▲ 1.24 KRW (+0.13%)` — 데이터가 없으면 안내 문구. */
export function formatChangeLine(
  changeAmount: number | null,
  changePercent: number | null,
): string {
  if (changeAmount === null) {
    return '― 비교할 이전 데이터가 없습니다';
  }
  const direction = trendOf(changeAmount);
  const symbol = trendSymbol(direction);
  const amount = formatSigned(changeAmount);
  const percent = changePercent === null ? '' : ` (${formatSigned(changePercent)}%)`;
  return `${symbol} ${amount} KRW${percent}`;
}

export interface StatusEmbedOptions {
  readonly staleAfterMinutes: number;
  readonly scrapeIntervalSeconds: number;
  /** 마지막 수집 실패 시각 (ISO). 있으면 경고 문구에 표시. */
  readonly lastFailureAt?: string | null;
  readonly lastFailureReason?: string | null;
  readonly consecutiveFailures?: number;
  readonly now?: Date;
}

/**
 * 매분 갱신되는 상태 메시지 Embed.
 *
 * 요구사항 3.2 의 모든 항목을 포함한다:
 *   현재 환율 / 전회 대비 / 당일 고저 / 수집 시각(KST + Discord 타임스탬프) /
 *   출처 / footer / 오래된 데이터 경고
 */
export function buildStatusEmbed(
  snapshot: RateSnapshot | null,
  options: StatusEmbedOptions,
): EmbedBuilder {
  const now = options.now ?? new Date();
  const intervalLabel = formatIntervalLabel(options.scrapeIntervalSeconds);

  if (snapshot === null) {
    return new EmbedBuilder()
      .setTitle('💴 YenWatch')
      .setColor(COLOR_ERROR)
      .setDescription(
        [
          '**아직 수집된 환율 데이터가 없습니다.**',
          '',
          '첫 수집이 완료되면 이 메시지가 자동으로 갱신됩니다.',
          options.lastFailureReason
            ? `\n최근 오류: \`${truncate(options.lastFailureReason, 200)}\``
            : '',
        ].join('\n'),
      )
      .setFooter({ text: `${intervalLabel} 자동 갱신 · v${APP_VERSION}` })
      .setTimestamp(now);
  }

  const stale = isStale(snapshot.collectedAt, options.staleAfterMinutes, now);
  const direction = trendOf(snapshot.changeAmount);

  const embed = new EmbedBuilder()
    .setTitle('💴 YenWatch')
    .setColor(stale ? COLOR_STALE : trendColor(direction))
    .addFields(
      {
        name: '현재 엔화 환율',
        value: `**100 JPY = ${formatRate(snapshot.rate)} KRW**`,
        inline: false,
      },
      {
        name: '전회 대비',
        value: formatChangeLine(snapshot.changeAmount, snapshot.changePercent),
        inline: true,
      },
      {
        name: '오늘 범위',
        value: [
          `고가 ${formatRate(snapshot.dailyHigh)} KRW`,
          `저가 ${formatRate(snapshot.dailyLow)} KRW`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '수집 시각',
        value: `${formatSeoul(snapshot.collectedAt)}\n${discordTimestamp(snapshot.collectedAt, 'R')}`,
        inline: false,
      },
      {
        name: '데이터 출처',
        value: `[${SOURCE_NAME}](${snapshot.source})`,
        inline: false,
      },
    )
    .setFooter({ text: `${intervalLabel} 자동 갱신 · v${APP_VERSION}` })
    .setTimestamp(now);

  if (stale) {
    const parts = [
      `⚠️ **데이터가 ${options.staleAfterMinutes}분 이상 갱신되지 않았습니다.**`,
      '아래 값은 마지막으로 정상 수집된 데이터입니다.',
    ];
    if (options.lastFailureAt) {
      parts.push(`오류 발생: ${formatSeoul(options.lastFailureAt)}`);
    }
    if (options.consecutiveFailures && options.consecutiveFailures > 0) {
      parts.push(`연속 실패: ${options.consecutiveFailures}회`);
    }
    if (options.lastFailureReason) {
      parts.push(`사유: \`${truncate(options.lastFailureReason, 200)}\``);
    }
    embed.setDescription(parts.join('\n'));
  }

  return embed;
}

/** `/yen` 응답 Embed — 상태 메시지와 같은 정보를 간결하게. */
export function buildCurrentRateEmbed(
  snapshot: RateSnapshot | null,
  options: StatusEmbedOptions,
): EmbedBuilder {
  if (snapshot === null) {
    return new EmbedBuilder()
      .setTitle('💴 현재 엔화 환율')
      .setColor(COLOR_ERROR)
      .setDescription('아직 수집된 데이터가 없습니다. 잠시 후 다시 시도해 주세요.');
  }

  const now = options.now ?? new Date();
  const stale = isStale(snapshot.collectedAt, options.staleAfterMinutes, now);
  const direction = trendOf(snapshot.changeAmount);

  const embed = new EmbedBuilder()
    .setTitle('💴 현재 엔화 환율')
    .setColor(stale ? COLOR_STALE : trendColor(direction))
    .setDescription(`**100 JPY = ${formatRate(snapshot.rate)} KRW**`)
    .addFields(
      {
        name: '전회 대비',
        value: formatChangeLine(snapshot.changeAmount, snapshot.changePercent),
        inline: true,
      },
      {
        name: '당일 최고 / 최저',
        value: `${formatRate(snapshot.dailyHigh)} / ${formatRate(snapshot.dailyLow)} KRW`,
        inline: true,
      },
      {
        name: '최근 수집 시각',
        value: `${formatSeoul(snapshot.collectedAt)} (${discordTimestamp(snapshot.collectedAt, 'R')})`,
        inline: false,
      },
    )
    .setFooter({ text: `출처: ${SOURCE_NAME}` })
    .setTimestamp(now);

  if (stale) {
    embed.addFields({
      name: '⚠️ 경고',
      value: `데이터가 ${options.staleAfterMinutes}분 이상 갱신되지 않았습니다.`,
      inline: false,
    });
  }

  return embed;
}

/** `/yen-history` 응답 Embed. */
export function buildHistoryEmbed(stats: RangeStats | null, periodInput: string): EmbedBuilder {
  if (stats === null) {
    return new EmbedBuilder()
      .setTitle(`📈 엔화 환율 이력 (${periodInput})`)
      .setColor(COLOR_FLAT)
      .setDescription('해당 기간에 저장된 데이터가 없습니다.');
  }

  const direction = trendOf(stats.changeAmount);
  const chart = sparkline(stats.series, { maxWidth: 28 });

  return new EmbedBuilder()
    .setTitle(`📈 엔화 환율 이력 — ${stats.periodLabel}`)
    .setColor(trendColor(direction))
    .setDescription(
      chart === '' ? '(그래프를 그릴 데이터가 부족합니다)' : `\`\`\`\n${chart}\n\`\`\``,
    )
    .addFields(
      { name: '시작 환율', value: `${formatRate(stats.openRate)} KRW`, inline: true },
      { name: '현재 환율', value: `${formatRate(stats.closeRate)} KRW`, inline: true },
      {
        name: '변화',
        value: `${trendSymbol(direction)} ${formatSigned(stats.changeAmount)} KRW (${formatSigned(stats.changePercent)}%)`,
        inline: true,
      },
      { name: '최고가', value: `${formatRate(stats.high)} KRW`, inline: true },
      { name: '최저가', value: `${formatRate(stats.low)} KRW`, inline: true },
      { name: '데이터 수', value: `${stats.dataPoints}건`, inline: true },
      {
        name: '기간',
        value: `${formatSeoul(stats.firstAt)}\n~ ${formatSeoul(stats.lastAt)}`,
        inline: false,
      },
    )
    .setFooter({ text: `출처: ${SOURCE_NAME}` })
    .setTimestamp(new Date());
}

export interface StatusCommandInfo {
  readonly health: HealthSnapshot;
  readonly discordConnected: boolean;
  readonly discordPingMs: number | null;
  readonly notionEnabled: boolean;
  readonly notionConnected: boolean | null;
  readonly sqliteOk: boolean;
  readonly sqliteRecords: number;
  readonly sqlitePath: string;
  readonly nextCollectionAt: string | null;
  readonly collecting: boolean;
  readonly activeAlerts: number;
}

/** `/yen-status` 응답 Embed (ephemeral). */
export function buildStatusCommandEmbed(info: StatusCommandInfo): EmbedBuilder {
  const { health } = info;
  const healthy = health.consecutiveFailures === 0;

  const statusIcon = (ok: boolean | null): string => {
    if (ok === null) return '⚪ 사용 안 함';
    return ok ? '🟢 정상' : '🔴 오류';
  };

  return new EmbedBuilder()
    .setTitle('🩺 YenWatch 상태')
    .setColor(healthy ? COLOR_OK : COLOR_ERROR)
    .addFields(
      { name: '봇 실행 시간', value: formatDuration(health.uptimeMs), inline: true },
      { name: '현재 버전', value: `v${health.version}`, inline: true },
      {
        name: '수집 상태',
        value: info.collecting ? '⏳ 수집 진행 중' : '💤 대기 중',
        inline: true,
      },
      {
        name: 'Discord',
        value: `${statusIcon(info.discordConnected)}${
          info.discordPingMs !== null && info.discordPingMs >= 0 ? ` (${info.discordPingMs}ms)` : ''
        }`,
        inline: true,
      },
      {
        name: 'Notion',
        value: info.notionEnabled ? statusIcon(info.notionConnected) : '⚪ 사용 안 함',
        inline: true,
      },
      {
        name: 'SQLite',
        value: `${statusIcon(info.sqliteOk)}\n${info.sqliteRecords.toLocaleString('ko-KR')}건`,
        inline: true,
      },
      {
        name: '마지막 수집 성공',
        value: health.lastSuccessAt
          ? `${formatSeoul(health.lastSuccessAt)}\n(${discordTimestamp(health.lastSuccessAt, 'R')})`
          : '없음',
        inline: true,
      },
      {
        name: '마지막 수집 실패',
        value: health.lastFailureAt
          ? `${formatSeoul(health.lastFailureAt)}\n(${discordTimestamp(health.lastFailureAt, 'R')})`
          : '없음',
        inline: true,
      },
      {
        name: '연속 실패 횟수',
        value: `${health.consecutiveFailures}회`,
        inline: true,
      },
      {
        name: '등록된 알림',
        value: info.activeAlerts > 0 ? `🔔 ${info.activeAlerts}개 감시 중` : '없음',
        inline: true,
      },
      {
        name: '다음 수집 예정',
        value: info.nextCollectionAt
          ? `${formatSeoul(info.nextCollectionAt)}\n(${discordTimestamp(info.nextCollectionAt, 'R')})`
          : '예약 없음',
        inline: false,
      },
    )
    .setFooter({ text: `DB: ${info.sqlitePath}` })
    .setTimestamp(new Date());
}

/** 연속 실패 경고 메시지. */
export function buildFailureAlertEmbed(params: {
  readonly consecutiveFailures: number;
  readonly threshold: number;
  readonly reason: string;
  readonly lastSuccessAt: string | null;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('🚨 YenWatch 수집 실패 경고')
    .setColor(COLOR_ERROR)
    .setDescription(
      `환율 수집이 **연속 ${params.consecutiveFailures}회** 실패했습니다 (임계치: ${params.threshold}회).`,
    )
    .addFields(
      { name: '오류 내용', value: `\`${truncate(params.reason, 500)}\``, inline: false },
      {
        name: '마지막 성공',
        value: params.lastSuccessAt ? formatSeoul(params.lastSuccessAt) : '없음',
        inline: true,
      },
      {
        name: '확인 사항',
        value: [
          '• 네이버 금융 접속 가능 여부',
          '• 라즈베리파이 네트워크 상태',
          '• `journalctl -u yenwatch -f` 로그',
        ].join('\n'),
        inline: false,
      },
    )
    .setFooter({ text: '복구되면 자동으로 알려드립니다 · 이 경고는 1회만 발송됩니다' })
    .setTimestamp(new Date());
}

/** 복구 알림 메시지. */
export function buildRecoveryEmbed(snapshot: RateSnapshot): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('✅ YenWatch 복구됨')
    .setColor(COLOR_OK)
    .setDescription(
      `환율 수집이 정상으로 돌아왔습니다.\n**100 JPY = ${formatRate(snapshot.rate)} KRW**`,
    )
    .addFields({ name: '수집 시각', value: formatSeoul(snapshot.collectedAt), inline: false })
    .setTimestamp(new Date());
}

// ------------------------------------------------------- 목표 환율 알림

/** `940 이하` / `960 이상` 형태의 조건 문구. */
export function formatAlertCondition(direction: AlertDirection, targetRate: number): string {
  return direction === 'below'
    ? `${formatRate(targetRate)} KRW 이하`
    : `${formatRate(targetRate)} KRW 이상`;
}

/** 알림 발동 메시지. 실제 멘션은 message content 로 따로 붙인다. */
export function buildAlertEmbed(alert: RateAlert, snapshot: RateSnapshot): EmbedBuilder {
  const reached =
    alert.direction === 'below' ? '목표가 이하로 내려갔습니다' : '목표가 이상으로 올라갔습니다';

  const embed = new EmbedBuilder()
    .setTitle('💸 환전 타이밍입니다!!!!!')
    .setColor(alert.direction === 'below' ? COLOR_DOWN : COLOR_UP)
    .setDescription(`**100 JPY = ${formatRate(snapshot.rate)} KRW**\n${reached}`)
    .addFields(
      {
        name: '목표 조건',
        value: formatAlertCondition(alert.direction, alert.targetRate),
        inline: true,
      },
      {
        name: '현재 환율',
        value: `${formatRate(snapshot.rate)} KRW`,
        inline: true,
      },
      {
        name: '오늘 범위',
        value: `${formatRate(snapshot.dailyLow)} ~ ${formatRate(snapshot.dailyHigh)} KRW`,
        inline: true,
      },
      {
        name: '수집 시각',
        value: `${formatSeoul(snapshot.collectedAt)}\n${discordTimestamp(snapshot.collectedAt, 'R')}`,
        inline: false,
      },
    )
    .setTimestamp(new Date());

  if (alert.label) {
    embed.addFields({ name: '메모', value: truncate(alert.label, 200), inline: false });
  }

  embed.setFooter({
    text: alert.once
      ? `알림 #${alert.id} · 1회성이므로 이 알림은 종료됩니다`
      : `알림 #${alert.id} · 목표선에서 벗어나면 다시 감시합니다`,
  });

  return embed;
}

/** `/yen-alert list` 응답. */
export function buildAlertListEmbed(alerts: readonly RateAlert[], currentRate: number | null) {
  if (alerts.length === 0) {
    return new EmbedBuilder()
      .setTitle('🔔 등록된 환율 알림')
      .setColor(COLOR_FLAT)
      .setDescription(
        '등록된 알림이 없습니다.\n`/yen-alert add rate:940 direction:아래로` 처럼 추가하세요.',
      );
  }

  const lines = alerts.map((alert) => {
    const state = !alert.enabled
      ? '⏹️ 종료'
      : alert.armed
        ? '🟢 감시 중'
        : '🔕 발동됨(재무장 대기)';
    const target = formatAlertCondition(alert.direction, alert.targetRate);
    const mention = `<@${alert.mentionUserId}>`;
    const extras: string[] = [];
    if (alert.once) extras.push('1회성');
    if (alert.triggerCount > 0) extras.push(`${alert.triggerCount}회 발동`);
    if (alert.label) extras.push(truncate(alert.label, 40));

    return [
      `**#${alert.id}** ${target} → ${mention}`,
      `└ ${state}${extras.length > 0 ? ` · ${extras.join(' · ')}` : ''}`,
    ].join('\n');
  });

  return new EmbedBuilder()
    .setTitle('🔔 등록된 환율 알림')
    .setColor(COLOR_OK)
    .setDescription(lines.join('\n\n'))
    .setFooter({
      text:
        currentRate === null
          ? '삭제: /yen-alert remove id:<번호>'
          : `현재 ${formatRate(currentRate)} KRW · 삭제: /yen-alert remove id:<번호>`,
    })
    .setTimestamp(new Date());
}

/** `60` -> `1분마다`, `90` -> `90초마다` */
export function formatIntervalLabel(seconds: number): string {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? '1분마다' : `${minutes}분마다`;
  }
  return `${seconds}초마다`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
