import pino, { type Logger, type LoggerOptions } from 'pino';

/**
 * 구조화 로깅.
 *
 * - production: JSON 한 줄 로그 (journalctl 에 그대로 쌓임)
 * - development: pino-pretty 로 사람이 읽기 좋은 출력
 *
 * 보안: 토큰/시크릿 계열 키는 redact 로 강제 마스킹한다.
 */

/** 구조화 로그의 `event` 필드에 사용하는 값. */
export const LogEvent = {
  APP_STARTED: 'app_started',
  DISCORD_CONNECTED: 'discord_connected',
  DISCORD_MESSAGE_CREATED: 'discord_message_created',
  DISCORD_MESSAGE_UPDATED: 'discord_message_updated',
  NOTION_CONNECTED: 'notion_connected',
  NOTION_PAGE_CREATED: 'notion_page_created',
  NOTION_PAGE_UPDATED: 'notion_page_updated',
  RATE_COLLECTION_STARTED: 'rate_collection_started',
  RATE_COLLECTED: 'rate_collected',
  RATE_COLLECTION_FAILED: 'rate_collection_failed',
  RATE_COLLECTION_SKIPPED: 'rate_collection_skipped',
  FAILURE_ALERT_SENT: 'failure_alert_sent',
  SERVICE_RECOVERED: 'service_recovered',
  RETENTION_COMPLETED: 'retention_completed',
  SHUTDOWN_STARTED: 'shutdown_started',
  SHUTDOWN_COMPLETED: 'shutdown_completed',
} as const;

export type LogEventName = (typeof LogEvent)[keyof typeof LogEvent];

const REDACT_PATHS = [
  'token',
  'DISCORD_TOKEN',
  'NOTION_TOKEN',
  'auth',
  'authorization',
  'headers.authorization',
  'config.headers.Authorization',
  '*.token',
  '*.DISCORD_TOKEN',
  '*.NOTION_TOKEN',
];

let rootLogger: Logger | null = null;

export interface LoggerConfig {
  readonly level: string;
  readonly pretty: boolean;
}

/** 루트 로거를 생성/초기화한다. */
export function initLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level: config.level,
    base: undefined, // pid/hostname 제거 — journald 가 이미 붙여준다
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };

  rootLogger = config.pretty
    ? pino({
        ...options,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
            ignore: 'pid,hostname',
            messageFormat: '{event} {msg}',
          },
        },
      })
    : pino(options);

  return rootLogger;
}

/** 초기화되지 않았다면 기본 설정으로 생성한다. */
export function getLogger(): Logger {
  if (!rootLogger) {
    rootLogger = initLogger({
      level: process.env.LOG_LEVEL ?? 'info',
      pretty: process.env.NODE_ENV !== 'production',
    });
  }
  return rootLogger;
}

/**
 * 컴포넌트 이름이 붙은 자식 로거.
 *
 * 왜 Proxy 인가:
 *   대부분의 모듈이 최상단에서 `const log = childLogger('x')` 를 호출한다.
 *   이 시점은 `initLogger()` 보다 **먼저** 실행되므로(import 평가 순서),
 *   자식 로거를 즉시 만들면 `.env` 가 반영되지 않은 기본 설정에 영구히 묶인다.
 *   Proxy 로 실제 사용 시점에 루트를 다시 확인해, initLogger 의 레벨/포맷이
 *   모든 모듈에 제대로 적용되게 한다.
 */
export function childLogger(component: string): Logger {
  let cachedChild: Logger | null = null;
  let cachedRoot: Logger | null = null;

  const resolve = (): Logger => {
    const root = getLogger();
    if (cachedChild === null || cachedRoot !== root) {
      cachedRoot = root;
      cachedChild = root.child({ component });
    }
    return cachedChild;
  };

  return new Proxy({} as Logger, {
    get(_target, property, _receiver) {
      const target = resolve();
      const value = Reflect.get(target, property) as unknown;
      // pino 메서드는 `this` 에 의존하므로 실제 자식 로거에 바인딩한다.
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
    set(_target, property, value) {
      return Reflect.set(resolve(), property, value);
    },
    has(_target, property) {
      return Reflect.has(resolve(), property);
    },
  });
}
