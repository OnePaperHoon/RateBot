import process from 'node:process';
import { initLogger } from '../logger.js';
import { APP_VERSION } from '../version.js';
import {
  backupDb,
  checkNotion,
  createEnvFile,
  editEnvGroup,
  fixEnvPermissions,
  registerDiscordCommands,
  runRetention,
  setEnvValue,
  showDatabaseStatus,
  showEnvValues,
  showOverview,
  showServiceGuide,
  testScrape,
  verifyEnv,
} from './actions.js';
import { ENV_GROUPS } from './envSpec.js';
import { color, createPrompter, heading, print, warn, type Prompter } from './ui.js';

/**
 * YenWatch 관리 CLI — `npm run cli`
 *
 * 대화형 메뉴로 다음을 수행한다:
 *   · .env 생성 및 항목별 편집
 *   · 환경변수 검증
 *   · 네이버 수집 테스트 (저장 여부 선택)
 *   · Discord 슬래시 커맨드 등록
 *   · Notion 연결/스키마 점검
 *   · SQLite 상태 조회 / 백업 / 보존 정책 실행
 *   · systemd 명령 안내
 *
 * 비대화형 서브커맨드도 지원한다 (스크립트/원격 접속용):
 *   npm run cli -- status
 *   npm run cli -- check
 *   npm run cli -- set KEY VALUE
 *   npm run cli -- scrape
 *   npm run cli -- notion
 *   npm run cli -- discord:register
 *   npm run cli -- backup
 */

const MENU_ITEMS: readonly string[] = [
  '종료',
  '.env 파일 만들기 (.env.example 기반)',
  '환경변수 편집 (그룹 선택)',
  '환경변수 값 보기 / 권한 확인',
  '환경변수 검증',
  '환율 수집 테스트 (네이버 실제 호출)',
  'Discord 슬래시 커맨드 등록',
  'Notion 연결 및 스키마 점검',
  'SQLite 상태 보기',
  'SQLite 백업',
  '데이터 보존 정책 즉시 실행',
  'systemd 서비스 명령 안내',
];

async function runMenuChoice(choice: number, prompter: Prompter): Promise<boolean> {
  switch (choice) {
    case 0:
      return false;

    case 1:
      createEnvFile();
      return true;

    case 2: {
      const groupIndex = await prompter.select(
        '어떤 그룹을 편집할까요?',
        ENV_GROUPS.map((group) => group.title),
      );
      const group = ENV_GROUPS[groupIndex];
      if (!group) {
        warn('취소했습니다.');
        return true;
      }
      await editEnvGroup(prompter, group);
      return true;
    }

    case 3: {
      showEnvValues();
      if (await prompter.confirm('\n.env 권한을 600 으로 설정할까요?', false)) {
        fixEnvPermissions();
      }
      return true;
    }

    case 4:
      verifyEnv();
      return true;

    case 5: {
      const persist = await prompter.confirm(
        '수집한 값을 SQLite 에 저장할까요? (아니오 = 읽기 전용 테스트)',
        false,
      );
      await testScrape(persist);
      return true;
    }

    case 6: {
      if (await prompter.confirm('Discord 에 슬래시 커맨드를 등록할까요?', true)) {
        await registerDiscordCommands();
      }
      return true;
    }

    case 7:
      await checkNotion();
      return true;

    case 8:
      showDatabaseStatus();
      return true;

    case 9:
      await backupDb();
      return true;

    case 10: {
      if (await prompter.confirm('보존 기간이 지난 데이터를 삭제합니다. 계속할까요?', false)) {
        runRetention();
      }
      return true;
    }

    case 11:
      showServiceGuide();
      return true;

    default:
      warn('알 수 없는 선택입니다.');
      return true;
  }
}

/** 비대화형 서브커맨드. 처리했으면 true. */
async function runSubcommand(argv: readonly string[]): Promise<boolean> {
  const [command, ...rest] = argv;
  if (command === undefined) return false;

  switch (command) {
    case 'status':
      showOverview();
      return true;

    case 'check':
      process.exitCode = verifyEnv() ? 0 : 1;
      return true;

    case 'env':
      showEnvValues();
      return true;

    case 'set': {
      const [key, ...valueParts] = rest;
      if (key === undefined) {
        warn('사용법: npm run cli -- set KEY VALUE');
        process.exitCode = 1;
        return true;
      }
      // `set KEY=VALUE` 와 `set KEY VALUE` 를 모두 지원한다.
      if (key.includes('=') && valueParts.length === 0) {
        const separatorIndex = key.indexOf('=');
        setEnvValue(key.slice(0, separatorIndex), key.slice(separatorIndex + 1));
      } else {
        setEnvValue(key, valueParts.join(' '));
      }
      return true;
    }

    case 'scrape':
      await testScrape(rest.includes('--save'));
      return true;

    case 'notion':
      await checkNotion();
      return true;

    case 'discord:register':
      await registerDiscordCommands();
      return true;

    case 'db':
      showDatabaseStatus();
      return true;

    case 'backup':
      await backupDb();
      return true;

    case 'retention':
      runRetention();
      return true;

    case 'service':
      showServiceGuide();
      return true;

    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return true;

    default:
      warn(`알 수 없는 명령: ${command}`);
      printHelp();
      process.exitCode = 1;
      return true;
  }
}

function printHelp(): void {
  heading(`YenWatch CLI v${APP_VERSION}`);
  print('  대화형 실행:  npm run cli');
  print();
  print(color.bold('  비대화형 명령'));
  print('    npm run cli -- status              전체 상태 요약');
  print('    npm run cli -- check               환경변수 검증 (실패 시 exit 1)');
  print('    npm run cli -- env                 환경변수 값 보기 (마스킹)');
  print('    npm run cli -- set KEY VALUE       환경변수 1개 설정');
  print('    npm run cli -- scrape [--save]     네이버 수집 테스트');
  print('    npm run cli -- notion              Notion 연결/스키마 점검');
  print('    npm run cli -- discord:register    슬래시 커맨드 등록');
  print('    npm run cli -- db                  SQLite 상태');
  print('    npm run cli -- backup              SQLite 온라인 백업');
  print('    npm run cli -- retention           보존 정책 즉시 실행');
  print('    npm run cli -- service             systemd 명령 안내');
  print();
}

async function main(): Promise<void> {
  // CLI 에서는 로그가 메뉴 출력을 방해하지 않도록 경고 이상만 사람이 읽는 형식으로 남긴다.
  initLogger({ level: process.env.CLI_LOG_LEVEL ?? 'warn', pretty: true });

  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    await runSubcommand(argv);
    return;
  }

  if (!process.stdin.isTTY) {
    warn('대화형 터미널이 아닙니다. 비대화형 명령을 사용하세요.');
    printHelp();
    process.exitCode = 1;
    return;
  }

  const prompter = createPrompter();
  try {
    showOverview();

    for (;;) {
      const choice = await prompter.select('무엇을 할까요?', MENU_ITEMS);
      if (choice < 0) {
        warn('0 ~ 11 사이의 번호를 입력하세요.');
        continue;
      }

      const shouldContinue = await runMenuChoice(choice, prompter);
      if (!shouldContinue) break;

      print();
      print(color.dim('  ── Enter 를 누르면 메뉴로 돌아갑니다 ──'));
      await prompter.ask('');
    }

    print();
    print(color.cyan('  YenWatch CLI 를 종료합니다.'));
  } finally {
    prompter.close();
  }
}

void main().catch((error: unknown) => {
  print();
  print(color.red(`CLI 실행 중 오류: ${error instanceof Error ? error.message : String(error)}`));
  process.exitCode = 1;
});
