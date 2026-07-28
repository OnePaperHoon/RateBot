/**
 * pm2 프로세스 정의 — `pm2 start ecosystem.config.cjs`
 *
 * package.json 의 `"type": "module"` 때문에 `.js` 는 ESM 으로 해석된다.
 * pm2 설정은 CommonJS 여야 하므로 확장자를 `.cjs` 로 둔다.
 *
 * ⚠️ 이 앱은 반드시 **단일 인스턴스**로 실행해야 한다:
 *   · SQLite 파일 하나를 여러 프로세스가 쓰면 `database is locked` 가 난다
 *   · Discord 상태 메시지 1개를 여러 프로세스가 동시에 수정하면 서로 덮어쓴다
 *   · 중복 수집 방지 mutex 는 프로세스 내부에만 존재한다
 *   따라서 cluster 모드가 아니라 fork 모드 + instances: 1 이다.
 */

const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'yenwatch',

      // 빌드 산출물을 실행한다. (개발 중이라면 npm run dev 를 쓰는 편이 낫다)
      script: 'dist/index.js',
      cwd: __dirname,

      // ---------- 실행 형태 ----------
      // cluster 모드 금지. 위 주석 참고.
      exec_mode: 'fork',
      instances: 1,

      // ---------- 재시작 정책 ----------
      autorestart: true,
      // 비정상 종료 후 10초 뒤 재시작 (네트워크 복구 시간을 준다)
      restart_delay: 10_000,
      // 1분 안에 10회 넘게 죽으면 설정 오류일 가능성이 높다 -> 재시작 포기
      max_restarts: 10,
      min_uptime: '60s',
      // 파일 변경 감시는 운영에서 위험하다 (data/*.db 쓰기마다 재시작됨)
      watch: false,

      // ---------- 종료 처리 ----------
      // 앱이 SIGINT/SIGTERM 을 받아 진행 중인 수집을 끝내고 SQLite 를 안전하게 닫는다.
      // 그 시간을 충분히 준다. (src/index.ts 의 워치독은 25초)
      kill_timeout: 30_000,
      // pm2 가 SIGINT 를 보낸 뒤 SIGKILL 하기 전 대기
      shutdown_with_message: false,
      listen_timeout: 10_000,

      // ---------- 메모리 ----------
      // 라즈베리파이 보호용 안전장치. 정상 동작 시 100MB 를 넘지 않는다.
      max_memory_restart: '300M',

      // ---------- 로그 ----------
      // pino 가 이미 ISO 타임스탬프를 붙이므로 pm2 의 시간 접두사는 끈다.
      // (켜면 JSON 한 줄 로그 앞에 텍스트가 붙어 jq 파싱이 깨진다)
      time: false,
      merge_logs: true,
      out_file: path.join(__dirname, 'logs', 'yenwatch-out.log'),
      error_file: path.join(__dirname, 'logs', 'yenwatch-error.log'),

      // ---------- 환경변수 ----------
      // 나머지 값은 앱이 시작할 때 cwd 의 `.env` 를 직접 읽는다 (dotenv).
      // 여기에 토큰을 적지 말 것 — 이 파일은 Git 에 커밋된다.
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Seoul',
      },
    },
  ],
};
