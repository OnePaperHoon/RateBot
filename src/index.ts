import process from 'node:process';
import { YenWatchApp } from './app.js';
import { loadEnv } from './config/env.js';
import { ConfigError } from './errors.js';
import { getLogger, initLogger } from './logger.js';
import { APP_VERSION } from './version.js';

/**
 * YenWatch 진입점.
 *
 * 책임:
 *  - 환경변수 로드/검증 (실패 시 명확한 메시지와 함께 exit 1)
 *  - 로거 초기화
 *  - 앱 기동
 *  - SIGINT / SIGTERM 처리 (systemd 재시작 대응)
 *  - 처리되지 않은 예외/거부가 프로세스를 조용히 죽이지 않게 방어
 */

/** 종료 절차가 끝나지 않아도 이 시간이 지나면 강제 종료한다 (systemd TimeoutStopSec 대비). */
const FORCE_EXIT_TIMEOUT_MS = 25_000;

/** 정리가 끝난 뒤 이벤트 루프가 비워지길 기다리는 유예 시간. */
const DRAIN_GRACE_MS = 3_000;

/**
 * 종료 코드를 정하고 프로세스가 **반드시** 끝나게 만든다.
 *
 * 두 가지 실패 모드를 동시에 막는다:
 *  1. `process.exit()` 즉시 호출 → 핸들 정리 중에 죽어 마지막 로그가 유실되거나
 *     libuv 가 assertion 으로 터진다.
 *  2. `exitCode` 만 설정 → 정리되지 않은 핸들(소켓 등)이 남으면 프로세스가
 *     영원히 살아 있고, 봇은 죽었는데 pm2/systemd 는 "online" 으로 본다.
 *     이 경우 자동 재시작이 아예 동작하지 않아 가장 위험하다.
 *
 * unref 된 타이머라 루프가 스스로 비면 발동하지 않고 깨끗하게 끝나며,
 * 핸들이 남아 루프가 살아 있으면 유예 시간 뒤 강제 종료한다.
 */
function exitWhenDrained(code: number, graceMs = DRAIN_GRACE_MS): void {
  process.exitCode = code;
  const forced = setTimeout(() => {
    process.exit(code);
  }, graceMs);
  forced.unref();
}

async function main(): Promise<void> {
  // 1. 환경변수 — 로거보다 먼저 필요하므로 여기서 검증한다.
  let env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof ConfigError) {
      // 로거가 아직 없으므로 stderr 에 직접 쓴다. 값은 출력하지 않는다.
      process.stderr.write(`\n[YenWatch] 시작할 수 없습니다.\n\n${error.message}\n\n`);
      process.exit(1);
    }
    throw error;
  }

  // 2. 로거
  initLogger({
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV !== 'production',
  });
  const log = getLogger();

  // 3. 앱 기동
  const app = new YenWatchApp(env);
  let exiting = false;

  /**
   * 종료 처리.
   *
   * 정리를 모두 마친 뒤 `exitWhenDrained()` 로 넘긴다.
   * 루프가 스스로 비면 깨끗이 끝나고, 남은 핸들이 있으면 유예 후 강제 종료한다.
   * 정리 자체가 걸리는 경우는 아래 워치독이 처리한다.
   */
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (exiting) return;
    exiting = true;

    // systemd 가 SIGKILL 하기 전에 스스로 빠져나가기 위한 안전장치.
    const forceTimer = setTimeout(() => {
      log.fatal({ event: 'shutdown_forced' }, '종료가 지연되어 강제 종료합니다');
      process.exit(exitCode === 0 ? 1 : exitCode);
    }, FORCE_EXIT_TIMEOUT_MS);
    forceTimer.unref();

    try {
      await app.shutdown(signal);
    } catch (error) {
      log.error({ err: error }, '종료 절차 중 오류');
    } finally {
      clearTimeout(forceTimer);
      exitWhenDrained(exitCode);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Windows 개발 환경 대응
  process.on('SIGHUP', () => void shutdown('SIGHUP'));

  process.on('unhandledRejection', (reason) => {
    log.error({ event: 'unhandled_rejection', err: reason }, '처리되지 않은 Promise 거부');
  });

  process.on('uncaughtException', (error) => {
    log.fatal({ event: 'uncaught_exception', err: error }, '처리되지 않은 예외 — 종료합니다');
    void shutdown('uncaughtException', 1);
  });

  try {
    await app.start();
  } catch (error) {
    if (error instanceof ConfigError) {
      log.fatal(`\n${error.message}\n`);
    } else {
      log.fatal({ err: error }, 'YenWatch 기동 실패');
    }
    exiting = true;
    await app.shutdown('startup_failure');
    // 반드시 종료되어야 한다. 살아만 있고 아무 일도 안 하면
    // pm2/systemd 가 "정상" 으로 오해해 재시작조차 하지 않는다.
    exitWhenDrained(1);
  }
}

process.title = `yenwatch-${APP_VERSION}`;

void main();
