#!/usr/bin/env bash
#
# YenWatch 라즈베리파이 설치 스크립트
#
# 사용법:
#   cd /opt/yenwatch
#   sudo ./deploy/install.sh
#
# 수행 내용:
#   1. OS 패키지 설치 (빌드 도구 포함 — better-sqlite3 네이티브 모듈 대비)
#   2. Node.js LTS 설치 (없거나 버전이 낮을 때만)
#   3. 의존성 설치 및 빌드
#   4. .env 준비 (권한 600)
#   5. systemd 유닛 생성 및 활성화
#
# 이 스크립트는 멱등합니다. 여러 번 실행해도 안전합니다.

set -euo pipefail

# ---------------------------------------------------------------- 설정
readonly APP_NAME="yenwatch"
readonly APP_DIR="${APP_DIR:-/opt/yenwatch}"
readonly SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
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

step()  { printf '\n%s==> %s%s\n' "${C_CYAN}${C_BOLD}" "$*" "${C_RESET}"; }
ok()    { printf '%s  ✓%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
warn()  { printf '%s  !%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*"; }
fail()  { printf '%s  ✗%s %s\n' "${C_RED}" "${C_RESET}" "$*" >&2; }
die()   { fail "$*"; exit 1; }

# ------------------------------------------------------------ 사전 확인
require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "root 권한이 필요합니다. 다시 실행하세요:  sudo $0"
  fi
}

# sudo 로 실행됐을 때 실제 로그인 사용자를 찾는다 (pi 를 하드코딩하지 않는다)
detect_user() {
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    echo "${SUDO_USER}"
  else
    # 로그인 세션이 없으면 UID 1000 사용자를 사용
    getent passwd 1000 | cut -d: -f1
  fi
}

detect_arch() {
  local arch
  arch="$(uname -m)"
  case "${arch}" in
    aarch64|arm64) echo "ARM64 (64-bit) — 권장 환경입니다" ;;
    armv7l|armv6l) echo "ARM32 (${arch}) — 64-bit OS 사용을 권장합니다" ;;
    x86_64)        echo "x86_64" ;;
    *)             echo "${arch} (알 수 없음)" ;;
  esac
}

# ------------------------------------------------------------ 설치 단계
install_os_packages() {
  step "OS 패키지 설치"
  export DEBIAN_FRONTEND=noninteractive

  apt-get update -qq
  # build-essential / python3 / make / g++ 는 better-sqlite3 가
  # prebuilt 바이너리를 못 받았을 때 소스 빌드에 필요하다.
  apt-get install -y -qq \
    git curl ca-certificates \
    build-essential python3 make g++ \
    sqlite3 \
    tzdata
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

  warn "Node.js ${MIN_NODE_MAJOR} 이상이 필요합니다 (현재: ${current_major:-없음}) — 설치를 진행합니다"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
  ok "설치 완료: $(node --version)"
}

setup_timezone() {
  step "시간대 설정"
  if [[ "$(cat /etc/timezone 2>/dev/null || true)" == "Asia/Seoul" ]]; then
    ok "이미 Asia/Seoul 입니다"
  else
    timedatectl set-timezone Asia/Seoul 2>/dev/null || ln -sf /usr/share/zoneinfo/Asia/Seoul /etc/localtime
    ok "Asia/Seoul 로 설정했습니다"
  fi
}

build_app() {
  local run_user="$1"

  step "애플리케이션 빌드"
  cd "${APP_DIR}"

  # 소유권을 실행 사용자로 맞춘다 (root 로 만든 node_modules 를 못 지우는 문제 방지)
  chown -R "${run_user}:${run_user}" "${APP_DIR}"

  if [[ -f package-lock.json ]]; then
    sudo -u "${run_user}" npm ci
  else
    warn "package-lock.json 이 없어 npm install 을 사용합니다"
    sudo -u "${run_user}" npm install
  fi
  ok "의존성 설치 완료"

  sudo -u "${run_user}" npm run build
  ok "TypeScript 빌드 완료 (dist/)"

  sudo -u "${run_user}" mkdir -p "${APP_DIR}/data"
  ok "데이터 디렉터리 준비: ${APP_DIR}/data"
}

setup_env_file() {
  local run_user="$1"

  step ".env 준비"
  if [[ -f "${APP_DIR}/.env" ]]; then
    ok ".env 가 이미 있습니다 (덮어쓰지 않음)"
  else
    cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
    warn ".env 를 새로 만들었습니다 — 값을 채워야 합니다"
  fi

  chown "${run_user}:${run_user}" "${APP_DIR}/.env"
  chmod 600 "${APP_DIR}/.env"
  ok "권한을 600 으로 설정했습니다"
}

install_service() {
  local run_user="$1"
  local node_path
  node_path="$(command -v node)"

  step "systemd 서비스 설치"

  # 템플릿의 사용자/경로를 실제 환경 값으로 치환한다.
  sed \
    -e "s|^User=.*|User=${run_user}|" \
    -e "s|^Group=.*|Group=${run_user}|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=${APP_DIR}|" \
    -e "s|^EnvironmentFile=.*|EnvironmentFile=${APP_DIR}/.env|" \
    -e "s|^ExecStart=.*|ExecStart=${node_path} ${APP_DIR}/dist/index.js|" \
    -e "s|^ReadWritePaths=.*|ReadWritePaths=${APP_DIR}/data|" \
    "${APP_DIR}/deploy/yenwatch.service" > "${SERVICE_FILE}"

  ok "생성: ${SERVICE_FILE}"
  printf '      User        = %s\n' "${run_user}"
  printf '      ExecStart   = %s %s/dist/index.js\n' "${node_path}" "${APP_DIR}"

  systemctl daemon-reload
  systemctl enable "${APP_NAME}" >/dev/null 2>&1
  ok "부팅 시 자동 실행이 활성화되었습니다"
}

verify_env_configured() {
  # .env 의 필수 값이 비어 있으면 서비스를 시작하지 않는다.
  if grep -qE '^DISCORD_TOKEN=.+' "${APP_DIR}/.env" 2>/dev/null; then
    return 0
  fi
  return 1
}

print_next_steps() {
  local run_user="$1"

  printf '\n%s────────────────────────────────────────────────%s\n' "${C_CYAN}" "${C_RESET}"
  printf '%s  설치 완료%s\n' "${C_BOLD}${C_GREEN}" "${C_RESET}"
  printf '%s────────────────────────────────────────────────%s\n\n' "${C_CYAN}" "${C_RESET}"

  if verify_env_configured; then
    printf '  서비스를 시작하세요:\n\n'
    printf '    sudo systemctl start %s\n' "${APP_NAME}"
    printf '    sudo systemctl status %s\n' "${APP_NAME}"
    printf '    journalctl -u %s -f\n\n' "${APP_NAME}"
  else
    printf '  %s.env 값을 아직 채우지 않았습니다.%s 다음 순서로 진행하세요:\n\n' "${C_YELLOW}" "${C_RESET}"
    printf '    1. 설정 입력\n'
    printf '       cd %s && npm run cli\n\n' "${APP_DIR}"
    printf '    2. 설정 검증\n'
    printf '       npm run check\n\n'
    printf '    3. 슬래시 커맨드 등록\n'
    printf '       npm run discord:register\n\n'
    printf '    4. 서비스 시작\n'
    printf '       sudo systemctl start %s\n' "${APP_NAME}"
    printf '       journalctl -u %s -f\n\n' "${APP_NAME}"
  fi

  printf '  실행 사용자 : %s\n' "${run_user}"
  printf '  설치 경로   : %s\n' "${APP_DIR}"
  printf '  DB 파일     : %s/data/yenwatch.db\n' "${APP_DIR}"
  printf '  아키텍처    : %s\n\n' "$(detect_arch)"
}

# ---------------------------------------------------------------- main
main() {
  require_root

  local run_user
  run_user="$(detect_user)"
  [[ -n "${run_user}" ]] || die "실행 사용자를 찾지 못했습니다. APP_USER 환경변수로 지정하세요."
  run_user="${APP_USER:-${run_user}}"

  printf '\n%s  YenWatch 설치%s\n' "${C_BOLD}" "${C_RESET}"
  printf '  경로: %s\n' "${APP_DIR}"
  printf '  사용자: %s\n' "${run_user}"
  printf '  아키텍처: %s\n' "$(detect_arch)"

  [[ -d "${APP_DIR}" ]] || die "${APP_DIR} 가 없습니다. 먼저 저장소를 clone 하세요."
  [[ -f "${APP_DIR}/package.json" ]] || die "${APP_DIR} 에 package.json 이 없습니다."
  id "${run_user}" >/dev/null 2>&1 || die "사용자 ${run_user} 가 존재하지 않습니다."

  install_os_packages
  install_node
  setup_timezone
  build_app "${run_user}"
  setup_env_file "${run_user}"
  install_service "${run_user}"
  print_next_steps "${run_user}"
}

main "$@"
