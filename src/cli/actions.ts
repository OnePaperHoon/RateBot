import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { formatEnvIssues, loadDotenv, resetEnvCache, validateEnv } from '../config/env.js';
import { backupDatabase, checkIntegrity, closeDatabase, openDatabase } from '../database/client.js';
import { HealthRepository } from '../database/healthRepository.js';
import { RateRepository } from '../database/rateRepository.js';
import { SettingsRepository } from '../database/settingsRepository.js';
import { registerSlashCommands } from '../discord/registerCommands.js';
import { commandDefinitions } from '../discord/commands.js';
import {
  checkConnection,
  createNotionClient,
  describeNotionError,
  fetchAndValidateDataSource,
} from '../notion/client.js';
import {
  HISTORY_PROPERTIES,
  STATUS_PROPERTIES,
  formatSchemaReport,
  validateSchema,
} from '../notion/schema.js';
import { NaverJpyScraper } from '../scraper/naverJpyScraper.js';
import { RetentionService } from '../services/retentionService.js';
import { calcChangeAmount, calcChangePercent, formatRate, formatSigned } from '../utils/money.js';
import { formatSeoul } from '../utils/time.js';
import { NotionSchemaError } from '../errors.js';
import { APP_VERSION } from '../version.js';

import {
  DEFAULT_ENV_PATH,
  createEnvFromExample,
  envFileExists,
  hasSecurePermissions,
  readEnvFile,
  securePermissions,
  updateEnvFile,
} from './envFile.js';
import { ENV_GROUPS, type EnvGroup } from './envSpec.js';
import {
  color,
  fail,
  heading,
  info,
  maskValue,
  ok,
  print,
  table,
  warn,
  type Prompter,
} from './ui.js';

/**
 * CLI 각 메뉴의 실제 동작.
 *
 * 모든 액션은 예외를 밖으로 던지지 않고 사용자에게 읽을 수 있는 메시지를 출력한다.
 * (관리 도구가 스택 트레이스로 죽으면 초보자가 막힌다)
 */

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** `.env` 를 다시 읽어 process.env 에 반영한다. */
function reloadEnv(): void {
  resetEnvCache();
  const file = readEnvFile();
  for (const [key, value] of file) {
    process.env[key] = value;
  }
  loadDotenv();
}

const DEFAULT_NAVER_URL =
  'https://finance.naver.com/marketindex/exchangeDetail.naver?marketindexCd=FX_JPYKRW';

/**
 * 수집/저장에 필요한 설정만 뽑아낸다.
 *
 * 스크레이퍼와 SQLite 는 Discord/Notion 자격증명 없이도 동작하므로,
 * 전체 환경변수 검증을 통과하지 못해도 이 부분만은 테스트할 수 있어야 한다.
 * (초기 설정 중인 사용자가 가장 먼저 확인하고 싶어하는 항목이다)
 */
function localConfigFromEnv(): {
  url: string;
  timeoutMs: number;
  minValid: number;
  maxValid: number;
  sqlitePath: string;
  retentionDays: number;
} {
  const num = (key: string, fallback: number): number => {
    const raw = process.env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const str = (key: string, fallback: string): string => {
    const raw = process.env[key];
    return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
  };

  return {
    url: str('NAVER_JPY_URL', DEFAULT_NAVER_URL),
    timeoutMs: num('REQUEST_TIMEOUT_MS', 10_000),
    minValid: num('MIN_VALID_JPY100_KRW', 100),
    maxValid: num('MAX_VALID_JPY100_KRW', 2_000),
    sqlitePath: str('SQLITE_PATH', './data/yenwatch.db'),
    retentionDays: num('DATA_RETENTION_DAYS', 365),
  };
}

// ------------------------------------------------------------ 상태 요약

export function showOverview(): void {
  heading(`YenWatch 관리 도구 v${APP_VERSION}`);

  const envExists = envFileExists();
  const rows: Array<readonly [string, string]> = [
    ['프로젝트 경로', process.cwd()],
    ['.env 파일', envExists ? color.green(DEFAULT_ENV_PATH) : color.red('없음')],
    ['Node.js', process.version],
    ['플랫폼', `${os.platform()} ${os.arch()}`],
  ];

  if (envExists && !hasSecurePermissions()) {
    rows.push(['.env 권한', color.yellow('600 이 아님 — 메뉴 3에서 수정할 수 있습니다')]);
  }

  table(rows);

  if (!envExists) {
    print();
    warn('.env 파일이 없습니다. 메뉴 1에서 만들 수 있습니다.');
    return;
  }

  reloadEnv();
  const validation = validateEnv();
  print();
  if (validation.ok) {
    ok('환경변수 검증 통과');
    const env = validation.env;
    table([
      ['수집 주기', `${env.SCRAPE_INTERVAL_SECONDS}초`],
      ['유효 범위', `${env.MIN_VALID_JPY100_KRW} ~ ${env.MAX_VALID_JPY100_KRW} KRW / 100 JPY`],
      ['Notion', env.NOTION_ENABLED ? '사용' : '사용 안 함'],
      [
        'Notion 이력',
        env.NOTION_HISTORY_ENABLED
          ? `사용 (${env.NOTION_HISTORY_INTERVAL_MINUTES}분)`
          : '사용 안 함',
      ],
      ['DB 경로', env.SQLITE_PATH],
      ['보존 기간', `${env.DATA_RETENTION_DAYS}일`],
    ]);
  } else {
    fail(`환경변수 문제 ${validation.issues.length}건`);
    for (const issue of validation.issues) {
      print(`    ${color.red('✗')} ${issue.key}: ${issue.message}`);
    }
  }
}

// ------------------------------------------------------- .env 생성/편집

export function createEnvFile(): void {
  heading('.env 파일 생성');
  const result = createEnvFromExample();

  switch (result) {
    case 'created':
      ok(`.env 를 만들었습니다: ${DEFAULT_ENV_PATH}`);
      info('비밀값은 비워져 있습니다. 메뉴 2에서 채우세요.');
      if (os.platform() !== 'win32') ok('권한을 600 으로 설정했습니다.');
      break;
    case 'exists':
      warn('.env 가 이미 존재합니다. 덮어쓰지 않았습니다.');
      break;
    case 'no-example':
      fail('.env.example 을 찾을 수 없습니다. 프로젝트 루트에서 실행했는지 확인하세요.');
      break;
  }
}

/** 그룹 단위 대화형 편집. */
export async function editEnvGroup(prompter: Prompter, group: EnvGroup): Promise<void> {
  heading(group.title);

  const current = readEnvFile();
  const updates = new Map<string, string>();

  for (const spec of group.vars) {
    const existing = current.get(spec.key) ?? '';
    print();
    print(
      `${color.bold(spec.label)} ${color.dim(`(${spec.key})`)}${spec.required ? color.red(' *필수') : ''}`,
    );
    print(`  ${color.dim(spec.hint)}`);
    print(`  현재 값: ${maskValue(spec.key, existing)}`);

    const fallback = existing !== '' ? existing : (spec.defaultValue ?? '');
    const answer = await prompter.ask('  새 값 (Enter=유지)', fallback);

    if (answer !== existing) {
      updates.set(spec.key, answer);
    }
  }

  if (updates.size === 0) {
    print();
    info('변경된 값이 없습니다.');
    return;
  }

  updateEnvFile(updates);
  print();
  ok(`${updates.size}개 값을 저장했습니다.`);
  for (const key of updates.keys()) {
    print(`    · ${key}`);
  }

  reloadEnv();
  const validation = validateEnv();
  if (validation.ok) {
    ok('환경변수 검증 통과');
  } else {
    warn('아직 남은 문제가 있습니다:');
    for (const issue of validation.issues) {
      print(`    ${color.red('✗')} ${issue.key}: ${issue.message}`);
    }
  }
}

/** 단일 키 설정 (비대화형: `npm run cli -- set KEY VALUE`). */
export function setEnvValue(key: string, value: string): void {
  updateEnvFile(new Map([[key, value]]));
  ok(`${key} 를 저장했습니다.`);
  reloadEnv();
}

/** 전체 환경변수 목록을 마스킹해 보여준다. */
export function showEnvValues(): void {
  heading('환경변수 현재 값');

  if (!envFileExists()) {
    warn('.env 파일이 없습니다.');
    return;
  }

  const current = readEnvFile();
  for (const group of ENV_GROUPS) {
    print();
    print(color.bold(`  ${group.title}`));
    table(
      group.vars.map(
        (spec) => [spec.key, maskValue(spec.key, current.get(spec.key) ?? '')] as const,
      ),
      '    ',
    );
  }

  print();
  if (hasSecurePermissions()) {
    ok('.env 파일 권한 정상');
  } else {
    warn('.env 파일 권한이 600 이 아닙니다.');
  }
}

export function fixEnvPermissions(): void {
  heading('.env 권한 수정');
  if (os.platform() === 'win32') {
    info('Windows 에서는 파일 권한 변경이 필요하지 않습니다.');
    return;
  }
  if (securePermissions()) {
    ok('.env 권한을 600 으로 변경했습니다.');
  } else {
    fail('.env 파일이 없습니다.');
  }
}

export function verifyEnv(): boolean {
  heading('환경변수 검증');
  reloadEnv();
  const validation = validateEnv();

  if (validation.ok) {
    ok('모든 환경변수가 올바릅니다.');
    return true;
  }

  print(formatEnvIssues(validation.issues));
  return false;
}

// --------------------------------------------------------------- 수집

/** 실제 네이버에서 1회 수집한다. 저장 여부는 선택. */
export async function testScrape(persist: boolean): Promise<void> {
  heading('환율 수집 테스트');
  reloadEnv();

  // Discord/Notion 설정이 아직 없어도 수집 자체는 확인할 수 있어야 한다.
  const config = localConfigFromEnv();
  const scraper = new NaverJpyScraper({
    url: config.url,
    timeoutMs: config.timeoutMs,
    minValid: config.minValid,
    maxValid: config.maxValid,
  });

  info(`요청: ${config.url}`);
  info(`유효 범위: ${config.minValid} ~ ${config.maxValid} KRW / 100 JPY`);
  const startedAt = Date.now();

  try {
    const result = await scraper.fetchRate();
    const durationMs = Date.now() - startedAt;

    ok(`수집 성공 (${durationMs}ms)`);
    table([
      ['환율', color.bold(`100 JPY = ${formatRate(result.rate)} KRW`)],
      ['사용 파서', result.parser],
      ['HTTP 상태', String(result.diagnostics.httpStatus)],
      ['Content-Type', result.diagnostics.contentType],
      ['응답 길이', `${result.diagnostics.contentLength.toLocaleString('ko-KR')} bytes`],
      ['인코딩', result.diagnostics.charset],
      ['수집 시각', formatSeoul(result.collectedAt)],
    ]);

    if (!persist) {
      info('저장하지 않았습니다 (읽기 전용 테스트).');
      return;
    }

    const db = openDatabase({ filePath: config.sqlitePath });
    try {
      const rates = new RateRepository(db);
      const previous = rates.findLatest();
      const saved = rates.insert({
        rate: result.rate,
        changeAmount: calcChangeAmount(result.rate, previous?.rate ?? null),
        changePercent: calcChangePercent(result.rate, previous?.rate ?? null),
        collectedAt: result.collectedAt,
        source: result.source,
      });
      ok(`SQLite 에 저장했습니다 (id=${saved.id}, 총 ${rates.count()}건)`);
    } finally {
      closeDatabase(db);
    }
  } catch (error) {
    fail(`수집 실패: ${describeError(error)}`);
    info('네트워크 상태와 NAVER_JPY_URL 을 확인하세요.');
  }
}

// -------------------------------------------------------------- Discord

export async function registerDiscordCommands(): Promise<void> {
  heading('Discord 슬래시 커맨드 등록');
  reloadEnv();

  const validation = validateEnv();
  if (!validation.ok) {
    fail('환경변수가 유효하지 않습니다. 메뉴 4로 확인하세요.');
    return;
  }
  const env = validation.env;

  info(
    `등록할 커맨드: ${commandDefinitions()
      .map((command) => `/${command.name}`)
      .join(', ')}`,
  );

  try {
    const result = await registerSlashCommands({
      token: env.DISCORD_TOKEN,
      clientId: env.DISCORD_CLIENT_ID,
      guildId: env.DISCORD_GUILD_ID,
    });
    ok(
      `${result.scope === 'guild' ? '길드' : '글로벌'} 커맨드 ${result.commandNames.length}개 등록 완료`,
    );
    if (result.scope === 'guild') {
      info('길드 커맨드는 즉시 반영됩니다. Discord 에서 `/yen` 을 입력해 보세요.');
    }
  } catch (error) {
    fail(describeError(error));
  }
}

// --------------------------------------------------------------- Notion

export async function checkNotion(): Promise<void> {
  heading('Notion 연결 및 스키마 점검');
  reloadEnv();

  const validation = validateEnv();
  if (!validation.ok) {
    fail('환경변수가 유효하지 않습니다. 메뉴 4로 확인하세요.');
    return;
  }
  const env = validation.env;

  if (!env.NOTION_ENABLED) {
    info('NOTION_ENABLED=false 이므로 Notion 을 사용하지 않습니다.');
    return;
  }

  const client = createNotionClient({ token: env.NOTION_TOKEN });

  const connection = await checkConnection(client);
  if (!connection.ok) {
    fail(`Notion 연결 실패: ${connection.error ?? '알 수 없음'}`);
    info('NOTION_TOKEN 이 Internal Integration Secret 인지 확인하세요.');
    return;
  }
  ok(`Notion 연결 성공${connection.botName ? ` (integration: ${connection.botName})` : ''}`);

  await inspectDataSource(
    client,
    env.NOTION_DATA_SOURCE_ID,
    STATUS_PROPERTIES,
    '상태 데이터베이스',
  );

  if (env.NOTION_HISTORY_ENABLED) {
    await inspectDataSource(
      client,
      env.NOTION_HISTORY_DATA_SOURCE_ID,
      HISTORY_PROPERTIES,
      '이력 데이터베이스',
    );
  } else {
    print();
    info('NOTION_HISTORY_ENABLED=false — 이력 데이터베이스는 점검하지 않습니다.');
  }
}

async function inspectDataSource(
  client: ReturnType<typeof createNotionClient>,
  dataSourceId: string,
  required: typeof STATUS_PROPERTIES,
  label: string,
): Promise<void> {
  print();
  try {
    const { dataSource } = await fetchAndValidateDataSource(client, dataSourceId, required, label);
    const result = validateSchema(dataSource, required);
    print(formatSchemaReport(result, label));
  } catch (error) {
    if (error instanceof NotionSchemaError) {
      print(error.report);
      return;
    }
    fail(`[${label}] 점검 실패: ${describeNotionError(error)}`);
  }
}

// ------------------------------------------------------------- SQLite

export function showDatabaseStatus(): void {
  heading('SQLite 상태');
  reloadEnv();

  const dbPath = localConfigFromEnv().sqlitePath;

  if (!fs.existsSync(dbPath)) {
    warn(`DB 파일이 아직 없습니다: ${dbPath}`);
    info('봇을 한 번 실행하거나 메뉴 5(저장 포함)를 실행하면 생성됩니다.');
    return;
  }

  const db = openDatabase({ filePath: dbPath });
  try {
    const rates = new RateRepository(db);
    const settings = new SettingsRepository(db);
    const health = new HealthRepository(db);

    const latest = rates.findLatest();
    const stats = fs.statSync(dbPath);

    table([
      ['파일', path.resolve(dbPath)],
      ['크기', `${(stats.size / 1024).toFixed(1)} KB`],
      ['무결성', checkIntegrity(db) === 'ok' ? color.green('ok') : color.red('손상 의심')],
      ['환율 레코드', `${rates.count().toLocaleString('ko-KR')}건`],
      ['헬스 이벤트', `${health.count().toLocaleString('ko-KR')}건`],
    ]);

    if (latest) {
      print();
      print(color.bold('  최근 환율'));
      table(
        [
          ['환율', `100 JPY = ${formatRate(latest.rate)} KRW`],
          [
            '전회 대비',
            latest.changeAmount === null
              ? '—'
              : `${formatSigned(latest.changeAmount)} KRW (${formatSigned(latest.changePercent ?? 0)}%)`,
          ],
          ['수집 시각', formatSeoul(latest.collectedAt)],
        ],
        '    ',
      );

      const extremes = rates.dailyExtremes(latest.collectedAt);
      if (extremes) {
        table(
          [
            ['당일 고가', `${formatRate(extremes.high)} KRW`],
            ['당일 저가', `${formatRate(extremes.low)} KRW`],
            ['당일 건수', `${extremes.count}건 (${extremes.dayKey})`],
          ],
          '    ',
        );
      }
    }

    const saved = settings.all();
    if (saved.length > 0) {
      print();
      print(color.bold('  저장된 운영 상태'));
      table(
        saved.map(
          (row) => [row.key, `${row.value}  ${color.dim(formatSeoul(row.updatedAt))}`] as const,
        ),
        '    ',
      );
    }

    const recentErrors = health.recentByLevel('error', 5);
    if (recentErrors.length > 0) {
      print();
      print(color.bold(`  최근 오류 ${recentErrors.length}건`));
      for (const event of recentErrors) {
        print(`    ${color.red('✗')} [${event.component}] ${event.message}`);
        print(`      ${color.dim(formatSeoul(event.occurredAt))}`);
      }
    }
  } catch (error) {
    fail(describeError(error));
  } finally {
    closeDatabase(db);
  }
}

export async function backupDb(): Promise<void> {
  heading('SQLite 백업');
  reloadEnv();

  const dbPath = localConfigFromEnv().sqlitePath;

  if (!fs.existsSync(dbPath)) {
    fail(`DB 파일이 없습니다: ${dbPath}`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const destination = path.join(
    path.dirname(path.resolve(dbPath)),
    'backups',
    `yenwatch-${stamp}.db`,
  );

  const db = openDatabase({ filePath: dbPath, migrate: false });
  try {
    // 온라인 백업 — 봇이 실행 중이어도 안전한 스냅샷을 만든다.
    await backupDatabase(db, destination);
    const size = fs.statSync(destination).size;
    ok(`백업 완료: ${destination} (${(size / 1024).toFixed(1)} KB)`);
  } catch (error) {
    fail(`백업 실패: ${describeError(error)}`);
  } finally {
    closeDatabase(db);
  }
}

export function runRetention(): void {
  heading('데이터 보존 정책 실행');
  reloadEnv();

  const config = localConfigFromEnv();
  if (!fs.existsSync(config.sqlitePath)) {
    fail(`DB 파일이 없습니다: ${config.sqlitePath}`);
    return;
  }

  const db = openDatabase({ filePath: config.sqlitePath });
  try {
    const service = new RetentionService({
      rates: new RateRepository(db),
      health: new HealthRepository(db),
      settings: new SettingsRepository(db),
      retentionDays: config.retentionDays,
    });
    const result = service.run();
    ok('정리 완료');
    table([
      ['기준 시각', formatSeoul(result.cutoffIso)],
      ['삭제된 환율', `${result.deletedRates.toLocaleString('ko-KR')}건`],
      ['삭제된 이벤트', `${result.deletedHealthEvents.toLocaleString('ko-KR')}건`],
      ['VACUUM', result.vacuumed ? '실행' : '생략'],
      ['소요 시간', `${result.durationMs}ms`],
    ]);
  } catch (error) {
    fail(describeError(error));
  } finally {
    closeDatabase(db);
  }
}

// ------------------------------------------------------------- systemd

export function showServiceGuide(): void {
  heading('systemd 서비스 안내');

  if (os.platform() !== 'linux') {
    warn(`현재 플랫폼은 ${os.platform()} 입니다. systemd 는 라즈베리파이(Linux)에서 사용합니다.`);
    print();
  }

  print(color.bold('  설치'));
  print('    sudo cp deploy/yenwatch.service /etc/systemd/system/yenwatch.service');
  print('    sudo systemctl daemon-reload');
  print('    sudo systemctl enable yenwatch');
  print('    sudo systemctl start yenwatch');
  print();
  print(color.bold('  운영'));
  table(
    [
      ['상태 확인', 'sudo systemctl status yenwatch'],
      ['실시간 로그', 'journalctl -u yenwatch -f'],
      ['오늘 로그', 'journalctl -u yenwatch --since today'],
      ['재시작', 'sudo systemctl restart yenwatch'],
      ['중지', 'sudo systemctl stop yenwatch'],
      ['부팅 자동실행 확인', 'systemctl is-enabled yenwatch'],
    ],
    '    ',
  );
  print();
  print(color.bold('  설치 스크립트를 쓰면 위 과정을 자동화할 수 있습니다'));
  print('    sudo ./deploy/install.sh');
}
