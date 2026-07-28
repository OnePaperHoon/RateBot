import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { childLogger } from '../logger.js';
import {
  MAX_ALERTS_PER_USER,
  type AlertDirection,
  type AlertRepository,
} from '../database/alertRepository.js';
import type { ExchangeRateService, HistoryPeriod } from '../services/exchangeRateService.js';
import { HISTORY_PERIODS } from '../services/exchangeRateService.js';
import type { HealthService } from '../services/healthService.js';
import type { CollectionOutcome } from '../types/exchangeRate.js';
import { formatRate } from '../utils/money.js';
import { formatDuration } from '../utils/time.js';
import {
  buildAlertListEmbed,
  buildCurrentRateEmbed,
  buildHistoryEmbed,
  buildStatusCommandEmbed,
  formatAlertCondition,
} from './embeds.js';

const log = childLogger('discord-commands');

/** `/yen-refresh` 쿨다운 (요구사항 3.3). */
export const REFRESH_COOLDOWN_MS = 30_000;

/**
 * 슬래시 커맨드가 필요로 하는 의존성.
 * 인터페이스로 주입받아 테스트에서 대체할 수 있게 한다.
 */
export interface CommandDeps {
  readonly rateService: ExchangeRateService;
  readonly healthService: HealthService;
  readonly alertRepository: AlertRepository;
  /** 수집 + Discord/Notion 갱신까지 수행하는 함수 (정기 스케줄과 동일한 경로). */
  readonly runCollection: (trigger: 'manual') => Promise<CollectionOutcome>;
  readonly config: {
    readonly staleAfterMinutes: number;
    readonly scrapeIntervalSeconds: number;
    readonly allowedUserIds: readonly string[];
    readonly sqlitePath: string;
    readonly notionEnabled: boolean;
    readonly minValidRate: number;
    readonly maxValidRate: number;
  };
  /** 런타임 상태 조회 (index.ts 에서 주입). */
  readonly status: {
    readonly notionConnected: () => boolean | null;
    readonly sqliteHealthy: () => boolean;
    readonly nextCollectionAt: () => string | null;
  };
}

export interface SlashCommand {
  readonly data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void>;
}

// ---------------------------------------------------------------- /yen

const yenCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('yen')
    .setDescription('현재 엔화 환율(100 JPY 기준)을 보여줍니다')
    .toJSON(),

  async execute(interaction, deps) {
    const snapshot = deps.rateService.getLastKnownSnapshot();
    const embed = buildCurrentRateEmbed(snapshot, {
      staleAfterMinutes: deps.config.staleAfterMinutes,
      scrapeIntervalSeconds: deps.config.scrapeIntervalSeconds,
      lastFailureAt: deps.healthService.lastFailureAt,
    });
    await interaction.reply({ embeds: [embed] });
  },
};

// -------------------------------------------------------- /yen-history

const yenHistoryCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('yen-history')
    .setDescription('선택한 기간의 엔화 환율 통계를 보여줍니다')
    .addStringOption((option) =>
      option
        .setName('period')
        .setDescription('조회 기간')
        .setRequired(true)
        .addChoices(
          { name: '1시간', value: '1h' },
          { name: '6시간', value: '6h' },
          { name: '12시간', value: '12h' },
          { name: '24시간', value: '24h' },
          { name: '7일', value: '7d' },
        ),
    )
    .toJSON(),

  async execute(interaction, deps) {
    const raw = interaction.options.getString('period', true);
    if (!isHistoryPeriod(raw)) {
      await interaction.reply({
        content: `지원하지 않는 기간입니다: \`${raw}\` (가능: ${HISTORY_PERIODS.join(', ')})`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const stats = deps.rateService.getRangeStats(raw);
    await interaction.reply({ embeds: [buildHistoryEmbed(stats, raw)] });
  },
};

// --------------------------------------------------------- /yen-status

const yenStatusCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('yen-status')
    .setDescription('봇의 동작 상태를 확인합니다 (본인에게만 표시)')
    .toJSON(),

  async execute(interaction, deps) {
    const client: Client = interaction.client;

    const embed = buildStatusCommandEmbed({
      health: deps.healthService.snapshot(),
      discordConnected: client.isReady(),
      discordPingMs: Number.isFinite(client.ws.ping) ? Math.round(client.ws.ping) : null,
      notionEnabled: deps.config.notionEnabled,
      notionConnected: deps.status.notionConnected(),
      sqliteOk: deps.status.sqliteHealthy(),
      sqliteRecords: deps.rateService.countRecords(),
      sqlitePath: deps.config.sqlitePath,
      nextCollectionAt: deps.status.nextCollectionAt(),
      collecting: deps.rateService.isCollecting,
      activeAlerts: deps.alertRepository.findEnabled().length,
    });

    // 요구사항: 명령 실행자에게만 보이도록 ephemeral 응답
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

// -------------------------------------------------------- /yen-refresh

/** 사용자별 마지막 실행 시각 (쿨다운 추적). */
const refreshCooldowns = new Map<string, number>();

/** 테스트/재시작 시 쿨다운 초기화. */
export function resetRefreshCooldowns(): void {
  refreshCooldowns.clear();
}

const yenRefreshCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('yen-refresh')
    .setDescription('환율을 지금 즉시 다시 수집합니다 (허용된 사용자 전용)')
    .toJSON(),

  async execute(interaction, deps) {
    const userId = interaction.user.id;

    // 1. 권한 확인 — 허용 목록이 비어 있으면 아무도 실행할 수 없다.
    if (!deps.config.allowedUserIds.includes(userId)) {
      log.warn({ event: 'refresh_denied', userId }, '허용되지 않은 사용자의 /yen-refresh 시도');
      await interaction.reply({
        content:
          '이 명령을 실행할 권한이 없습니다.\n' +
          '`.env` 의 `DISCORD_ALLOWED_USER_IDS` 에 사용자 ID 를 추가하세요.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // 2. 쿨다운 확인
    const now = Date.now();
    const lastUsed = refreshCooldowns.get(userId);
    if (lastUsed !== undefined && now - lastUsed < REFRESH_COOLDOWN_MS) {
      const remainingMs = REFRESH_COOLDOWN_MS - (now - lastUsed);
      await interaction.reply({
        content: `쿨다운 중입니다. ${formatDuration(remainingMs)} 후에 다시 시도하세요.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // 3. 중복 실행 방지 — 정기 스케줄과 같은 lock 을 공유한다.
    if (deps.rateService.isCollecting) {
      await interaction.reply({
        content: '이미 수집 작업이 진행 중입니다. 잠시 후 상태 메시지를 확인하세요.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    refreshCooldowns.set(userId, now);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const outcome = await deps.runCollection('manual');

    if (outcome.status === 'success') {
      await interaction.editReply({
        content: `✅ 수집 완료 — **100 JPY = ${outcome.snapshot.rate.toFixed(2)} KRW** (${outcome.durationMs}ms)`,
      });
      return;
    }

    if (outcome.status === 'skipped') {
      await interaction.editReply({ content: `⏭️ 건너뜀 — ${outcome.reason}` });
      return;
    }

    await interaction.editReply({
      content:
        `❌ 수집 실패 — \`${outcome.error.message.slice(0, 500)}\`\n` +
        '마지막 정상 데이터는 그대로 유지됩니다.',
    });
  },
};

// ---------------------------------------------------------------------

// --------------------------------------------------------- /yen-alert

const DIRECTION_BELOW = 'below';
const DIRECTION_ABOVE = 'above';

function isDirection(value: string): value is AlertDirection {
  return value === DIRECTION_BELOW || value === DIRECTION_ABOVE;
}

const yenAlertCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('yen-alert')
    .setDescription('목표 환율에 도달하면 멘션으로 알려줍니다')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('목표 환율 알림을 추가합니다')
        .addNumberOption((option) =>
          option
            .setName('rate')
            .setDescription('목표 환율 (100 JPY 당 KRW). 예: 940')
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('direction')
            .setDescription('언제 알릴지')
            .setRequired(true)
            .addChoices(
              { name: '아래로 (목표가 이하로 내려가면 — 엔화 살 때)', value: DIRECTION_BELOW },
              { name: '위로 (목표가 이상으로 올라가면 — 엔화 팔 때)', value: DIRECTION_ABOVE },
            ),
        )
        .addUserOption((option) =>
          option.setName('user').setDescription('멘션할 사용자 (기본: 본인)').setRequired(false),
        )
        .addBooleanOption((option) =>
          option
            .setName('once')
            .setDescription('한 번만 알리고 종료 (기본: 반복)')
            .setRequired(false),
        )
        .addStringOption((option) =>
          option.setName('label').setDescription('메모 (예: 여행 경비 환전)').setRequired(false),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('등록된 알림을 보여줍니다'))
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('알림을 삭제합니다')
        .addIntegerOption((option) =>
          option
            .setName('id')
            .setDescription('알림 번호 (/yen-alert list 로 확인)')
            .setRequired(true),
        ),
    )
    .toJSON(),

  async execute(interaction, deps) {
    switch (interaction.options.getSubcommand()) {
      case 'add':
        await handleAlertAdd(interaction, deps);
        return;
      case 'list':
        await handleAlertList(interaction, deps);
        return;
      case 'remove':
        await handleAlertRemove(interaction, deps);
        return;
      default:
        await interaction.reply({
          content: '알 수 없는 하위 명령입니다.',
          flags: MessageFlags.Ephemeral,
        });
    }
  },
};

async function handleAlertAdd(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  const targetRate = interaction.options.getNumber('rate', true);
  const rawDirection = interaction.options.getString('direction', true);
  const targetUser = interaction.options.getUser('user');
  const once = interaction.options.getBoolean('once') ?? false;
  const label = interaction.options.getString('label');

  const invokerId = interaction.user.id;
  const mentionUserId = targetUser?.id ?? invokerId;

  if (!isDirection(rawDirection)) {
    await interaction.reply({
      content: '방향이 올바르지 않습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 목표가 유효 범위를 벗어나면 영원히 발동하지 않거나 즉시 발동한다 — 미리 막는다.
  const { minValidRate, maxValidRate } = deps.config;
  if (!Number.isFinite(targetRate) || targetRate < minValidRate || targetRate > maxValidRate) {
    await interaction.reply({
      content:
        `목표 환율은 ${minValidRate} ~ ${maxValidRate} KRW 사이여야 합니다. ` +
        `(입력값: ${targetRate})`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 남을 멘션하는 것은 허용된 사용자만 — 핑 남용 방지.
  if (mentionUserId !== invokerId && !deps.config.allowedUserIds.includes(invokerId)) {
    await interaction.reply({
      content:
        '다른 사람을 멘션하는 알림은 허용된 사용자만 만들 수 있습니다.\n' +
        '본인을 대상으로 하려면 `user` 옵션을 비워두세요.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (deps.alertRepository.countActiveByCreator(invokerId) >= MAX_ALERTS_PER_USER) {
    await interaction.reply({
      content: `알림은 최대 ${MAX_ALERTS_PER_USER}개까지 만들 수 있습니다. \`/yen-alert remove\` 로 정리하세요.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const created = deps.alertRepository.create({
    targetRate,
    direction: rawDirection,
    mentionUserId,
    createdBy: invokerId,
    channelId: interaction.channelId,
    label,
    once,
  });

  const snapshot = deps.rateService.getLastKnownSnapshot();
  const currentLine =
    snapshot === null
      ? ''
      : `\n현재 환율은 **${formatRate(snapshot.rate)} KRW** 입니다.` +
        (isAlreadyMet(rawDirection, targetRate, snapshot.rate)
          ? ' 이미 조건을 만족하므로 다음 수집 때 바로 알림이 갑니다.'
          : '');

  log.info(
    {
      event: 'alert_created',
      alertId: created.id,
      direction: created.direction,
      target: created.targetRate,
      once: created.once,
    },
    '환율 알림 등록',
  );

  await interaction.reply({
    content:
      `✅ 알림 **#${created.id}** 등록됨\n` +
      `조건: **${formatAlertCondition(created.direction, created.targetRate)}**\n` +
      `멘션 대상: <@${created.mentionUserId}>` +
      (created.once ? '\n1회성 알림입니다.' : '') +
      currentLine,
    flags: MessageFlags.Ephemeral,
  });
}

function isAlreadyMet(direction: AlertDirection, target: number, current: number): boolean {
  return direction === 'below' ? current <= target : current >= target;
}

async function handleAlertList(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  const alerts = deps.alertRepository.findAll();
  const snapshot = deps.rateService.getLastKnownSnapshot();
  await interaction.reply({
    embeds: [buildAlertListEmbed(alerts, snapshot?.rate ?? null)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleAlertRemove(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  const id = interaction.options.getInteger('id', true);
  const invokerId = interaction.user.id;

  const alert = deps.alertRepository.findById(id);
  if (!alert) {
    await interaction.reply({
      content: `알림 #${id} 을(를) 찾을 수 없습니다. \`/yen-alert list\` 로 확인하세요.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // 본인이 만든 것이거나, 허용된 사용자면 삭제할 수 있다.
  const canDelete = alert.createdBy === invokerId || deps.config.allowedUserIds.includes(invokerId);
  if (!canDelete) {
    await interaction.reply({
      content: '본인이 만든 알림만 삭제할 수 있습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  deps.alertRepository.delete(id);
  log.info({ event: 'alert_deleted', alertId: id, userId: invokerId }, '환율 알림 삭제');

  await interaction.reply({
    content: `🗑️ 알림 **#${id}** (${formatAlertCondition(alert.direction, alert.targetRate)}) 을(를) 삭제했습니다.`,
    flags: MessageFlags.Ephemeral,
  });
}

// ---------------------------------------------------------------------

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  yenCommand,
  yenHistoryCommand,
  yenStatusCommand,
  yenRefreshCommand,
  yenAlertCommand,
];

/** Discord 에 등록할 커맨드 정의(JSON) 목록. */
export function commandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return SLASH_COMMANDS.map((command) => command.data);
}

export function isHistoryPeriod(value: string): value is HistoryPeriod {
  return (HISTORY_PERIODS as readonly string[]).includes(value);
}

/**
 * 인터랙션 라우터.
 *
 * 커맨드 실행 중 오류가 나도 봇 전체가 죽지 않도록 여기서 모두 잡는다.
 */
export async function handleInteraction(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  const command = SLASH_COMMANDS.find((item) => item.data.name === interaction.commandName);

  if (!command) {
    log.warn({ commandName: interaction.commandName }, '알 수 없는 슬래시 커맨드');
    await safeReply(interaction, '알 수 없는 명령입니다.');
    return;
  }

  const startedAt = Date.now();
  try {
    await command.execute(interaction, deps);
    log.debug(
      {
        event: 'command_executed',
        commandName: interaction.commandName,
        userId: interaction.user.id,
        durationMs: Date.now() - startedAt,
      },
      '슬래시 커맨드 처리 완료',
    );
  } catch (error) {
    log.error(
      { event: 'command_failed', commandName: interaction.commandName, err: error },
      '슬래시 커맨드 처리 실패',
    );
    await safeReply(interaction, '명령을 처리하는 중 오류가 발생했습니다. 로그를 확인하세요.');
  }
}

/** 이미 응답했는지 여부에 따라 안전하게 응답한다. */
async function safeReply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  try {
    if (interaction.deferred) {
      await interaction.editReply({ content });
    } else if (!interaction.replied) {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    log.warn({ err: error }, '오류 응답 전송 실패 (무시)');
  }
}
