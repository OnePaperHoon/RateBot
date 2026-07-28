import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { childLogger } from '../logger.js';
import type { ExchangeRateService, HistoryPeriod } from '../services/exchangeRateService.js';
import { HISTORY_PERIODS } from '../services/exchangeRateService.js';
import type { HealthService } from '../services/healthService.js';
import type { CollectionOutcome } from '../types/exchangeRate.js';
import { formatDuration } from '../utils/time.js';
import { buildCurrentRateEmbed, buildHistoryEmbed, buildStatusCommandEmbed } from './embeds.js';

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
  /** 수집 + Discord/Notion 갱신까지 수행하는 함수 (정기 스케줄과 동일한 경로). */
  readonly runCollection: (trigger: 'manual') => Promise<CollectionOutcome>;
  readonly config: {
    readonly staleAfterMinutes: number;
    readonly scrapeIntervalSeconds: number;
    readonly allowedUserIds: readonly string[];
    readonly sqlitePath: string;
    readonly notionEnabled: boolean;
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

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  yenCommand,
  yenHistoryCommand,
  yenStatusCommand,
  yenRefreshCommand,
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
