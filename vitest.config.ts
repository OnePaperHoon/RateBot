import { defineConfig } from 'vitest/config';

/** 테스트 출력에 애플리케이션 로그가 섞이지 않도록 로거를 끈다. */
const SILENT_LOGS = { LOG_LEVEL: 'silent' };

export default defineConfig({
  test: {
    globals: false,
    // 단위 테스트(fixture 기반)와 통합 테스트(실제 네트워크 의존)를 분리한다.
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/integration/**'],
          environment: 'node',
          env: SILENT_LOGS,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
          env: SILENT_LOGS,
        },
      },
    ],
  },
});
