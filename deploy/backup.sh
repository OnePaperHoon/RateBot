#!/usr/bin/env bash
#
# YenWatch SQLite 백업 스크립트
#
# 서비스를 멈추지 않고 SQLite Online Backup API 로 안전한 스냅샷을 만든다.
# (WAL 모드에서 .db 파일만 cp 하면 일관성이 깨질 수 있다)
#
# 사용법:
#   ./deploy/backup.sh                 # 기본 위치에 백업
#   ./deploy/backup.sh /mnt/usb/backup # 지정한 위치에 백업
#
# cron 등록 예 (매일 새벽 3시):
#   0 3 * * * /opt/yenwatch/deploy/backup.sh >> /var/log/yenwatch-backup.log 2>&1

set -euo pipefail

readonly APP_DIR="${APP_DIR:-/opt/yenwatch}"
readonly DB_FILE="${APP_DIR}/data/yenwatch.db"
readonly KEEP="${KEEP:-14}"
BACKUP_DIR="${1:-${APP_DIR}/data/backups}"

timestamp="$(date +%Y%m%d-%H%M%S)"
destination="${BACKUP_DIR}/yenwatch-${timestamp}.db"

if [[ ! -f "${DB_FILE}" ]]; then
  echo "[$(date -Iseconds)] 오류: DB 파일이 없습니다: ${DB_FILE}" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"

# sqlite3 CLI 의 .backup 은 Online Backup API 를 사용하므로
# 봇이 실행 중이어도 일관된 스냅샷을 만든다.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "${DB_FILE}" ".backup '${destination}'"
else
  # sqlite3 가 없으면 프로젝트의 백업 스크립트를 사용한다.
  cd "${APP_DIR}"
  npm run --silent backup -- --out "${BACKUP_DIR}" --keep "${KEEP}"
  exit 0
fi

# 백업 파일 무결성 확인
integrity="$(sqlite3 "${destination}" 'PRAGMA integrity_check;')"
if [[ "${integrity}" != "ok" ]]; then
  echo "[$(date -Iseconds)] 경고: 백업 무결성 검사 실패 — ${integrity}" >&2
  exit 1
fi

size="$(du -h "${destination}" | cut -f1)"
echo "[$(date -Iseconds)] 백업 완료: ${destination} (${size})"

# 오래된 백업 정리 — 최근 KEEP 개만 남긴다
mapfile -t stale < <(ls -1t "${BACKUP_DIR}"/yenwatch-*.db 2>/dev/null | tail -n "+$((KEEP + 1))")
if [[ ${#stale[@]} -gt 0 ]]; then
  rm -f "${stale[@]}"
  echo "[$(date -Iseconds)] 오래된 백업 ${#stale[@]}개 삭제 (최근 ${KEEP}개 유지)"
fi
