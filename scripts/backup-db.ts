#!/usr/bin/env tsx
/**
 * `npm run backup`
 *
 * SQLite 온라인 백업. 봇을 멈추지 않아도 안전한 스냅샷을 만든다.
 * (better-sqlite3 의 backup API 는 SQLite Online Backup API 를 사용하므로
 *  WAL 모드에서 파일을 그냥 cp 하는 것보다 안전하다.)
 *
 * 옵션:
 *   --out <경로>     저장 위치 지정 (기본: <db 디렉터리>/backups/)
 *   --keep <개수>    최근 N개만 남기고 오래된 백업 삭제 (기본: 14)
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { formatEnvIssues, loadDotenv, validateEnv } from '../src/config/env.js';
import {
  backupDatabase,
  checkIntegrity,
  closeDatabase,
  openDatabase,
} from '../src/database/client.js';
import { RateRepository } from '../src/database/rateRepository.js';
import { initLogger } from '../src/logger.js';
import { fail, heading, info, ok, print, table, warn } from '../src/cli/ui.js';

function parseOption(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  return argv[index + 1] ?? null;
}

async function main(): Promise<void> {
  initLogger({ level: 'error', pretty: true });
  heading('SQLite 백업');

  loadDotenv();
  const validation = validateEnv();
  if (!validation.ok) {
    fail('환경변수 검증 실패');
    print(formatEnvIssues(validation.issues));
    process.exit(1);
  }
  const env = validation.env;
  const argv = process.argv.slice(2);

  if (!fs.existsSync(env.SQLITE_PATH)) {
    fail(`DB 파일이 없습니다: ${env.SQLITE_PATH}`);
    process.exit(1);
  }

  const keep = Number(parseOption(argv, '--keep') ?? 14);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir =
    parseOption(argv, '--out') ?? path.join(path.dirname(path.resolve(env.SQLITE_PATH)), 'backups');
  const destination = path.join(outDir, `yenwatch-${stamp}.db`);

  const db = openDatabase({ filePath: env.SQLITE_PATH, migrate: false });
  try {
    const records = new RateRepository(db).count();
    await backupDatabase(db, destination);

    const size = fs.statSync(destination).size;
    ok('백업 완료');
    table([
      ['원본', path.resolve(env.SQLITE_PATH)],
      ['백업 파일', destination],
      ['크기', `${(size / 1024).toFixed(1)} KB`],
      ['레코드 수', `${records.toLocaleString('ko-KR')}건`],
    ]);
  } catch (error) {
    fail(`백업 실패: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  } finally {
    closeDatabase(db);
  }

  // 백업 파일 자체의 무결성도 확인한다.
  try {
    const backupDb = openDatabase({ filePath: destination, migrate: false, readonly: true });
    try {
      const integrity = checkIntegrity(backupDb);
      if (integrity === 'ok') ok('백업 파일 무결성 검사 통과');
      else warn(`백업 파일 무결성 검사 결과: ${integrity}`);
    } finally {
      closeDatabase(backupDb);
    }
  } catch (error) {
    warn(`백업 파일 검사 실패: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 오래된 백업 정리
  if (Number.isInteger(keep) && keep > 0) {
    const files = fs
      .readdirSync(outDir)
      .filter((name) => name.startsWith('yenwatch-') && name.endsWith('.db'))
      .sort()
      .reverse();

    const stale = files.slice(keep);
    for (const name of stale) {
      fs.rmSync(path.join(outDir, name), { force: true });
    }
    if (stale.length > 0) {
      info(`오래된 백업 ${stale.length}개를 삭제했습니다 (최근 ${keep}개 유지).`);
    }
  }
}

void main().catch((error: unknown) => {
  fail(`백업 중 오류: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
