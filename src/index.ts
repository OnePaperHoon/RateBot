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
   * `process.exit()` 를 즉시 호출하지 않고 `exitCode` 만 설정한 뒤
   * 이벤트 루프가 자연스럽게 비워지길 기다린다.
   * (열려 있는 핸들이 정리되는 도중 강제 종료하면 libuv 가 죽거나
   *  마지막 로그가 유실될 수 있다.)
   * 그래도 끝나지 않으면 워치독이 강제 종료한다.
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
      process.exitCode = exitCode;
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
    // 여기서도 강제 종료하지 않는다 — 핸들이 정리되면 exitCode 1 로 자연 종료된다.
    process.exitCode = 1;
  }
}

process.title = `yenwatch-${APP_VERSION}`;

void main();
