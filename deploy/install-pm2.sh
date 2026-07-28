#!/usr/bin/env bash
#
# YenWatch 라즈베리파이 설치 스크립트 (pm2 버전)
#
# 사용법 — ⚠️ sudo 없이 **일반 사용자로** 실행하세요:
#   cd /opt/yenwatch
#   ./deploy/install-pm2.sh
#
# pm2 는 사용자 단위로 프로세스를 관리합니다. root 로 실행하면 root 의 pm2 데몬에
# 등록되어 로그인 사용자가 `pm2 status` 로 볼 수 없게 됩니다.
# apt 설치와 부팅 등록 단계에서만 sudo 를 요청합니다.
#
# 수행 내용:
#   1. OS 패키지 설치 (better-sqlite3 빌드 도구 포함)
#   2. Node.js LTS 설치 (없거나 버전이 낮을 때만)
#   3. pm2 및 pm2-logrotate 설치
#   4. 의존성 설치 및 빌드
#   5. .env 준비 (권한 600)
#   6. systemd 유닛과의 충돌 확인
#   7. pm2 등록 + 부팅 자동 실행 설정
#
# 이 스크립트는 멱등합니다. 여러 번 실행해도 안전합니다.

set -euo pipefail

# ---------------------------------------------------------------- 설정
readonly APP_NAME="yenwatch"
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
readonly APP_DIR
readonly MIN_NODE_MAJOR=20

# ------------------------------------------------------------ 출력 헬퍼
if [[ -t 1 ]]; then
  readonly C_RESET=$'\033[0m'
  readonly C_RED=$'\033[31m'
  readonly C_GREEN=$'\033[32m'
  readonly C_YELLOW=$'\033[33m'
  readonly C_CYAN=$'\033[36m'
  readonly C_BOLD=$'\033[1m'
else
  readonly C_RESET="" C_RED="" C_GREEN="" C_YELLOW="" C_CYAN="" C_BOLD=""
fi

step() { printf '\n%s==> %s%s\n' "${C_CYAN}${C_BOLD}" "$*" "${C_RESET}"; }
ok()   { printf '%s  ✓%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
warn() { printf '%s  !%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*"; }
fail() { printf '%s  ✗%s %s\n' "${C_RED}" "${C_RESET}" "$*" >&2; }
die()  { fail "$*"; exit 1; }

# ------------------------------------------------------------ 사전 확인
refuse_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    fail "이 스크립트는 sudo 없이 일반 사용자로 실행해야 합니다."
    printf '\n'
    printf '  pm2 는 사용자별로 동작합니다. root 로 등록하면 나중에\n'
    printf '  `pm2 status` 에 아무것도 보이지 않아 혼란스러워집니다.\n\n'
    printf '  이렇게 실행하세요:\n'
    printf '    cd %s && ./deploy/install-pm2.sh\n\n' "${APP_DIR}"
    exit 1
  fi
}

detect_arch() {
  case "$(uname -m)" in
    aarch64 | arm64) echo "ARM64 (64-bit) — 권장 환경입니다" ;;
    armv7l | armv6l) echo "ARM32 ($(uname -m)) — 64-bit OS 사용을 권장합니다" ;;
    x86_64) echo "x86_64" ;;
    *) echo "$(uname -m) (알 수 없음)" ;;
  esac
}

# ------------------------------------------------------------ 설치 단계
install_os_packages() {
  step "OS 패키지 설치 (sudo 필요)"
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  # build-essential / python3 / make / g++ 는 better-sqlite3 가
  # prebuilt 바이너리를 못 받았을 때 소스 빌드에 필요하다.
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    git curl ca-certificates \
    build-essential python3 make g++ \
    sqlite3 tzdata
  ok "패키지 설치 완료 (빌드 도구 포함)"
}

install_node() {
  step "Node.js 확인"

  local current_major=0
  if command -v node >/dev/null 2>&1; then
    current_major="$(node --version | sed 's/^v//' | cut -d. -f1)"
  fi

  if [[ "${current_major}" -ge "${MIN_NODE_MAJOR}" ]]; then
    ok "이미 설치됨: $(node --version)"
    return
  fi

  warn "Node.js ${MIN_NODE_MAJOR} 이상이 필요합니다 (현재: ${current_major:-없음})"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
  ok "설치 완료: $(node --version)"
}

install_pm2() {
  step "pm2 설치"

  if command -v pm2 >/dev/null 2>&1; then
    ok "이미 설치됨: pm2 $(pm2 --version)"
  else
    sudo npm install -g pm2
    ok "설치 완료: pm2 $(pm2 --version)"
  fi

  # 로그 회전 — 1분마다 로그를 남기므로 없으면 SD 카드가 금방 찬다.
  if pm2 list 2>/dev/null | grep -q 'pm2-logrotate'; then
    ok "pm2-logrotate 이미 설치됨"
  else
    pm2 install pm2-logrotate >/dev/null 2>&1 || warn "pm2-logrotate 설치 실패 (건너뜁니다)"
    ok "pm2-logrotate 설치"
  fi

  pm2 set pm2-logrotate:max_size 10M >/dev/null 2>&1 || true
  pm2 set pm2-logrotate:retain 14 >/dev/null 2>&1 || true
  pm2 set pm2-logrotate:compress true >/dev/null 2>&1 || true
  ok "로그 회전 설정: 10MB 마다 분할, 14개 보관, 압축"
}

setup_timezone() {
  step "시간대 설정"
  if [[ "$(cat /etc/timezone 2>/dev/null || true)" == "Asia/Seoul" ]]; then
    ok "이미 Asia/Seoul 입니다"
  else
    sudo timedatectl set-timezone Asia/Seoul 2>/dev/null ||
      sudo ln -sf /usr/share/zoneinfo/Asia/Seoul /etc/localtime
    ok "Asia/Seoul 로 설정했습니다"
  fi
}

build_app() {
  step "애플리케이션 빌드"
  cd "${APP_DIR}"

  if [[ -f package-lock.json ]]; then
    npm ci
  else
    warn "package-lock.json 이 없어 npm install 을 사용합니다"
    npm install
  fi
  ok "의존성 설치 완료"

  npm run build
  ok "TypeScript 빌드 완료 (dist/)"

  mkdir -p "${APP_DIR}/data" "${APP_DIR}/logs"
  ok "디렉터리 준비: data/ , logs/"
}

setup_env_file() {
  step ".env 준비"
  if [[ -f "${APP_DIR}/.env" ]]; then
    ok ".env 가 이미 있습니다 (덮어쓰지 않음)"
  else
    cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
    warn ".env 를 새로 만들었습니다 — 값을 채워야 합니다"
  fi

  chmod 600 "${APP_DIR}/.env"
  ok "권한을 600 으로 설정했습니다"
}

# 같은 앱이 systemd 로도 돌고 있으면 SQLite 가 잠기고 Discord 메시지가 충돌한다.
check_systemd_conflict() {
  step "systemd 충돌 확인"

  if ! systemctl list-unit-files 2>/dev/null | grep -q "^${APP_NAME}.service"; then
    ok "충돌하는 systemd 유닛 없음"
    return
  fi

  warn "systemd 에 ${APP_NAME}.service 가 등록되어 있습니다."
  printf '\n'
  printf '    pm2 와 systemd 가 동시에 이 앱을 실행하면 프로세스가 2개가 되어\n'
  printf '    SQLite 가 잠기고(database is locked) Discord 상태 메시지가 서로 덮어씁니다.\n'
  printf '    둘 중 하나만 사용해야 합니다.\n\n'

  read -r -p "  systemd 서비스를 중지하고 비활성화할까요? (Y/n) " answer
  if [[ "${answer}" =~ ^([nN]|[nN][oO])$ ]]; then
    warn "건너뜁니다 — 직접 정리하세요: sudo systemctl disable --now ${APP_NAME}"
    return
  fi

  sudo systemctl disable --now "${APP_NAME}" 2>/dev/null || true
  ok "systemd 서비스를 중지하고 부팅 자동 실행을 해제했습니다"
}

env_is_configured() {
  grep -qE '^DISCORD_TOKEN=.+' "${APP_DIR}/.env" 2>/dev/null
}

register_pm2() {
  step "pm2 등록"
  cd "${APP_DIR}"

  if ! env_is_configured; then
    warn ".env 가 아직 비어 있어 지금 시작하지 않습니다."
    warn "설정을 마친 뒤 아래를 실행하세요:  npm run pm2:start && pm2 save"
    return
  fi

  # startOrRestart: 없으면 시작, 있으면 재시작 (멱등)
  pm2 startOrRestart ecosystem.config.cjs --update-env
  pm2 save
  ok "pm2 에 등록하고 현재 목록을 저장했습니다"
}

setup_boot() {
  step "부팅 자동 실행 설정 (sudo 필요)"

  local node_bin_dir
  node_bin_dir="$(dirname "$(command -v node)")"

  # pm2 startup 은 systemd 유닛(pm2-<user>.service)을 만들어
  # 부팅 시 pm2 데몬과 저장된 프로세스 목록을 복원한다.
  sudo env PATH="${PATH}:${node_bin_dir}" \
    pm2 startup systemd -u "${USER}" --hp "${HOME}" >/dev/null

  ok "부팅 시 pm2 가 자동 실행됩니다 (pm2-${USER}.service)"

  if env_is_configured; then
    pm2 save >/dev/null
    ok "현재 프로세스 목록을 저장했습니다"
  else
    warn "아직 프로세스가 없습니다. 시작한 뒤 반드시 'pm2 save' 를 실행하세요."
  fi
}

print_next_steps() {
  printf '\n%s────────────────────────────────────────────────%s\n' "${C_CYAN}" "${C_RESET}"
  printf '%s  설치 완료 (pm2)%s\n' "${C_BOLD}${C_GREEN}" "${C_RESET}"
  printf '%s────────────────────────────────────────────────%s\n\n' "${C_CYAN}" "${C_RESET}"

  if env_is_configured; then
    printf '  상태 확인:\n\n'
    printf '    pm2 status\n'
    printf '    pm2 logs %s\n\n' "${APP_NAME}"
  else
    printf '  %s.env 값을 아직 채우지 않았습니다.%s 다음 순서로 진행하세요:\n\n' "${C_YELLOW}" "${C_RESET}"
    printf '    1. 설정 입력\n'
    printf '       cd %s && npm run cli\n\n' "${APP_DIR}"
    printf '    2. 설정 검증\n'
    printf '       npm run check\n\n'
    printf '    3. 슬래시 커맨드 등록\n'
    printf '       npm run discord:register\n\n'
    printf '    4. 시작 + 목록 저장 (save 를 빠뜨리면 재부팅 후 안 뜹니다)\n'
    printf '       npm run pm2:start\n'
    printf '       pm2 save\n\n'
    printf '    5. 확인\n'
    printf '       pm2 logs %s\n\n' "${APP_NAME}"
  fi

  printf '  실행 사용자 : %s\n' "${USER}"
  printf '  설치 경로   : %s\n' "${APP_DIR}"
  printf '  DB 파일     : %s/data/yenwatch.db\n' "${APP_DIR}"
  printf '  pm2 로그    : %s/logs/  (pm2 logs 로도 확인 가능)\n' "${APP_DIR}"
  printf '  아키텍처    : %s\n\n' "$(detect_arch)"
}

# ---------------------------------------------------------------- main
main() {
  refuse_root

  printf '\n%s  YenWatch 설치 (pm2)%s\n' "${C_BOLD}" "${C_RESET}"
  printf '  경로: %s\n' "${APP_DIR}"
  printf '  사용자: %s\n' "${USER}"
  printf '  아키텍처: %s\n' "$(detect_arch)"

  [[ -f "${APP_DIR}/package.json" ]] || die "${APP_DIR} 에 package.json 이 없습니다."

  install_os_packages
  install_node
  install_pm2
  setup_timezone
  build_app
  setup_env_file
  check_systemd_conflict
  register_pm2
  setup_boot
  print_next_steps
}

main "$@"
