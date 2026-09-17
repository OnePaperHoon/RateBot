/**
 * CLI 대화형 설정에 사용하는 환경변수 카탈로그.
 *
 * `config/env.ts` 의 Zod 스키마가 "검증" 을 담당한다면,
 * 여기는 "사람에게 설명하고 값을 받아내는" 역할을 한다.
 */

export interface EnvVarSpec {
  readonly key: string;
  readonly label: string;
  /** 어디서 값을 구하는지에 대한 안내. */
  readonly hint: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly defaultValue?: string;
  /** true/false 만 받는 값. */
  readonly boolean?: boolean;
}

export interface EnvGroup {
  readonly id: string;
  readonly title: string;
  readonly vars: readonly EnvVarSpec[];
}

export const ENV_GROUPS: readonly EnvGroup[] = [
  {
    id: 'discord',
    title: 'Discord 설정',
    vars: [
      {
        key: 'DISCORD_TOKEN',
        label: '봇 토큰',
        hint: 'Developer Portal > 애플리케이션 > Bot > Reset Token 으로 발급',
        required: true,
        secret: true,
      },
      {
        key: 'DISCORD_CLIENT_ID',
        label: '애플리케이션 ID',
        hint: 'Developer Portal > General Information > Application ID',
        required: true,
        secret: false,
      },
      {
        key: 'DISCORD_GUILD_ID',
        label: '서버(길드) ID',
        hint: '개발자 모드 활성화 후 서버 아이콘 우클릭 > 서버 ID 복사',
        required: true,
        secret: false,
      },
      {
        key: 'DISCORD_CHANNEL_ID',
        label: '환율 채널 ID',
        hint: '상태 메시지를 표시할 채널 우클릭 > 채널 ID 복사',
        required: true,
        secret: false,
      },
      {
        key: 'DISCORD_ALLOWED_USER_IDS',
        label: '/yen-refresh 허용 사용자 ID',
        hint: '쉼표로 구분. 본인 프로필 우클릭 > 사용자 ID 복사. 비우면 아무도 실행할 수 없습니다.',
        required: false,
        secret: false,
      },
    ],
  },
  {
    id: 'notion',
    title: 'Notion 설정',
    vars: [
      {
        key: 'NOTION_ENABLED',
        label: 'Notion 사용 여부',
        hint: 'false 로 두면 Discord + SQLite 만 사용합니다',
        required: false,
        secret: false,
        defaultValue: 'true',
        boolean: true,
      },
      {
        key: 'NOTION_TOKEN',
        label: 'Integration Secret',
        hint: 'notion.so/my-integrations > YenWatch > Internal Integration Secret',
        required: false,
        secret: true,
      },
      {
        key: 'NOTION_DATA_SOURCE_ID',
        label: '상태 데이터 소스 ID',
        hint: 'database ID 가 아니라 data source ID 입니다 (README 12.2 참고)',
        required: false,
        secret: false,
      },
      {
        key: 'NOTION_STATUS_PAGE_ID',
        label: '상태 페이지 ID (선택)',
        hint: '비우면 자동으로 찾거나 새로 만들고 SQLite 에 기억합니다',
        required: false,
        secret: false,
      },
      {
        key: 'NOTION_HISTORY_ENABLED',
        label: 'Notion 이력 사용 여부',
        hint: 'true 이면 별도 이력 DB 에 주기적으로 행을 추가합니다',
        required: false,
        secret: false,
        defaultValue: 'false',
        boolean: true,
      },
      {
        key: 'NOTION_HISTORY_DATA_SOURCE_ID',
        label: '이력 데이터 소스 ID',
        hint: 'NOTION_HISTORY_ENABLED=true 일 때만 필요합니다',
        required: false,
        secret: false,
      },
      {
        key: 'NOTION_HISTORY_INTERVAL_MINUTES',
        label: '이력 기록 주기(분)',
        hint: '1분마다 행을 만들면 과도하므로 기본 60분입니다',
        required: false,
        secret: false,
        defaultValue: '60',
      },
    ],
  },
  {
    id: 'scrape',
    title: '수집 설정',
    vars: [
      {
        key: 'NAVER_JPY_API_URL',
        label: '네이버 증권 환율 API URL',
        hint: '1순위 수집 경로. 보통 기본값 그대로 사용합니다 (끄려면 off)',
        required: false,
        secret: false,
        defaultValue: 'https://api.stock.naver.com/marketindex/exchange/FX_JPYKRW',
      },
      {
        key: 'NAVER_JPY_URL',
        label: '네이버 엔화 페이지 URL (HTML 폴백)',
        hint: 'API 가 실패할 때만 사용합니다. 보통 기본값 그대로 사용합니다',
        required: false,
        secret: false,
        defaultValue:
          'https://finance.naver.com/marketindex/exchangeDetail.naver?marketindexCd=FX_JPYKRW',
      },
      {
        key: 'SCRAPE_INTERVAL_SECONDS',
        label: '수집 주기(초)',
        hint: '기본 60초. 너무 짧게 두면 차단될 수 있습니다.',
        required: false,
        secret: false,
        defaultValue: '60',
      },
      {
        key: 'REQUEST_TIMEOUT_MS',
        label: 'HTTP 타임아웃(ms)',
        hint: '기본 10000',
        required: false,
        secret: false,
        defaultValue: '10000',
      },
      {
        key: 'STALE_AFTER_MINUTES',
        label: '오래된 데이터 기준(분)',
        hint: '이 시간을 넘기면 Discord 에 경고를 표시합니다',
        required: false,
        secret: false,
        defaultValue: '5',
      },
      {
        key: 'FAILURE_ALERT_THRESHOLD',
        label: '연속 실패 경고 임계치',
        hint: '이 횟수 이상 연속 실패하면 경고를 1회 발송합니다',
        required: false,
        secret: false,
        defaultValue: '5',
      },
      {
        key: 'MIN_VALID_JPY100_KRW',
        label: '유효 최소값 (100 JPY 당 KRW)',
        hint: '기본 100',
        required: false,
        secret: false,
        defaultValue: '100',
      },
      {
        key: 'MAX_VALID_JPY100_KRW',
        label: '유효 최대값 (100 JPY 당 KRW)',
        hint: '기본 2000',
        required: false,
        secret: false,
        defaultValue: '2000',
      },
    ],
  },
  {
    id: 'storage',
    title: '저장소 / 실행 환경',
    vars: [
      {
        key: 'SQLITE_PATH',
        label: 'SQLite 파일 경로',
        hint: '기본 ./data/yenwatch.db',
        required: false,
        secret: false,
        defaultValue: './data/yenwatch.db',
      },
      {
        key: 'DATA_RETENTION_DAYS',
        label: '데이터 보존 기간(일)',
        hint: '기본 365. 이보다 오래된 데이터는 매일 자동 삭제됩니다.',
        required: false,
        secret: false,
        defaultValue: '365',
      },
      {
        key: 'NODE_ENV',
        label: '실행 모드',
        hint: 'production 또는 development (development 는 사람이 읽기 쉬운 로그)',
        required: false,
        secret: false,
        defaultValue: 'production',
      },
      {
        key: 'LOG_LEVEL',
        label: '로그 레벨',
        hint: 'trace / debug / info / warn / error / fatal',
        required: false,
        secret: false,
        defaultValue: 'info',
      },
      {
        key: 'TZ',
        label: '시간대',
        hint: '표시 기준. 기본 Asia/Seoul',
        required: false,
        secret: false,
        defaultValue: 'Asia/Seoul',
      },
    ],
  },
];

/** 전체 스펙을 평탄화한 목록. */
export const ALL_ENV_VARS: readonly EnvVarSpec[] = ENV_GROUPS.flatMap((group) => group.vars);

export function findVarSpec(key: string): EnvVarSpec | undefined {
  return ALL_ENV_VARS.find((spec) => spec.key === key);
}
