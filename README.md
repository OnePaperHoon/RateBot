# 💴 YenWatch

라즈베리파이에서 24시간 돌아가는 **개인용 엔화(JPY/KRW) 환율 모니터링 봇**입니다.

네이버 금융에서 1분마다 환율을 가져와 **Discord 채널**, **Notion 데이터베이스**, **로컬 SQLite** 세 곳에 기록합니다.

```text
100 JPY = 946.32 KRW
```

---

## 목차

1. [프로젝트 소개](#1-프로젝트-소개)
2. [주요 기능](#2-주요-기능)
3. [시스템 구조](#3-시스템-구조)
4. [요구사항](#4-요구사항)
5. [Discord 봇 만들기](#5-discord-봇-만들기)
6. [Discord 서버에 초대하기](#6-discord-서버에-초대하기)
7. [Discord 권한 설정](#7-discord-권한-설정)
8. [Notion Integration 만들기](#8-notion-integration-만들기)
9. [Notion 데이터베이스 만들기](#9-notion-데이터베이스-만들기)
10. [로컬 개발 환경 설정](#10-로컬-개발-환경-설정)
11. [환경변수 설명](#11-환경변수-설명)
12. [실행 및 테스트](#12-실행-및-테스트)
13. [라즈베리파이 설치](#13-라즈베리파이-설치)
14. [자동 실행 설정 (pm2 / systemd)](#14-자동-실행-설정)
15. [로그 확인](#15-로그-확인)
16. [업데이트 방법](#16-업데이트-방법)
17. [데이터 백업](#17-데이터-백업)
18. [장애 해결](#18-장애-해결)
19. [보안 주의사항](#19-보안-주의사항)
20. [라이선스](#20-라이선스)

---

## 1. 프로젝트 소개

YenWatch는 일본 엔화 환율을 계속 지켜보는 개인용 봇입니다. 여행이나 직구, 환전 타이밍을 위해 환율을 자주 확인해야 하는데, 매번 사이트에 들어가는 게 번거로워서 만들었습니다.

Discord 채널에 **메시지 하나**를 만들어 두고, 그 메시지를 1분마다 수정합니다. 채널이 알림으로 도배되지 않으면서도 항상 최신 환율을 볼 수 있습니다.

| 항목        | 값                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| 데이터 출처 | [네이버 금융 — 일본 JPY](https://finance.naver.com/marketindex/exchangeDetail.naver?marketindexCd=FX_JPYKRW) |
| 표시 단위   | 100 JPY 당 KRW (소수점 둘째 자리)                                                                            |
| 수집 주기   | 1분 (변경 가능)                                                                                              |
| 실행 환경   | Raspberry Pi OS 64-bit, Node.js 20+                                                                          |
| 시간대      | 저장은 UTC(ISO 8601), 표시는 Asia/Seoul                                                                      |

---

## 2. 주요 기능

### 환율 수집

- 1분마다 자동 수집 + 시작 시 즉시 1회 수집
- **6개의 독립 파서**를 순서대로 시도 — 네이버 페이지 구조가 바뀌어도 잘 버팁니다
- EUC-KR 인코딩 정확 처리
- 유효 범위 검사(기본 100 ~ 2,000 KRW) — 이상한 값은 저장도 전송도 하지 않습니다
- 실패 시 1초 → 3초 → 10초 간격으로 최대 3회 재시도

### Discord

- 상태 메시지 **1개를 계속 수정** (매분 새 메시지를 보내지 않음)
- 메시지가 삭제되면 자동으로 다시 만들고 새 ID를 기억
- 상승 `▲` / 하락 `▼` / 보합 `―`, 변화량과 변화율, 당일 고가·저가
- 데이터가 5분 이상 낡으면 경고 표시
- 슬래시 커맨드 5개: `/yen`, `/yen-history`, `/yen-status`, `/yen-refresh`, `/yen-alert`

### 목표 환율 알림

목표 환율에 도달하면 지정한 사람을 **멘션**해서 알려줍니다.

```text
@내계정 💸 환전 타이밍입니다!!!!!

100 JPY = 938.40 KRW
목표가 이하로 내려갔습니다

목표 조건          현재 환율        오늘 범위
940.00 KRW 이하    938.40 KRW      938.40 ~ 949.10 KRW
```

- 방향 선택: `아래로`(엔화 싸질 때 = 살 때) / `위로`(비싸질 때 = 팔 때)
- **스팸 방지**: 목표 도달 시 한 번만 발송. 환율이 경계선에서 흔들려도 반복되지 않습니다
- 1회성 / 반복 선택 가능, 사용자당 최대 20개
- SQLite 에 저장되어 재시작해도 유지됩니다

### Notion

- 상태 행 **1개**를 매분 갱신 (페이지 자동 탐색 → 없으면 생성 → ID 기억)
- 이력 기록은 선택 기능 (기본 60분 주기 — 1분마다 행을 만들면 금방 수천 개가 됩니다)
- 속성 이름/타입이 안 맞으면 **종료하지 않고** 무엇을 어떻게 고쳐야 하는지 출력

### 안정성

- 수집 실패가 프로세스를 죽이지 않습니다
- Discord가 실패해도 Notion·SQLite는 계속 동작 (그 반대도 마찬가지)
- 연속 실패 5회에 경고 **1회**, 복구되면 복구 알림 **1회** (스팸 없음)
- 수집 작업 중복 실행 방지 (정기 스케줄과 `/yen-refresh`가 같은 lock 공유)
- SIGTERM/SIGINT 정상 종료 — 재부팅·재시작 시 SQLite가 깨지지 않습니다
- 1년보다 오래된 데이터 자동 정리
- pm2 fork 모드 단일 인스턴스로 실행 (SQLite·Discord 메시지 충돌 방지)

### 관리 도구

```bash
npm run cli        # 대화형 관리 도구 (.env 편집, 검증, 수집 테스트, 백업 등)
```

### 프로세스 관리

pm2로 상주 실행합니다. (systemd도 지원 — [13.0](#130-프로세스-관리자-선택) 참고)

```bash
npm run pm2:start     # 시작   (= pm2 start ecosystem.config.cjs)
npm run pm2:restart   # 재시작 (.env 변경 반영 포함)
npm run pm2:logs      # 로그
npm run pm2:status    # 상세 상태
pm2 save              # 재부팅 후에도 뜨도록 목록 저장
```

---

## 3. 시스템 구조

```text
                    ┌──────────────────────┐
                    │   네이버 금융 (EUC-KR)   │
                    └──────────┬───────────┘
                               │ 1분마다 HTTP GET (timeout 10s)
                               ▼
              ┌────────────────────────────────────┐
              │  NaverJpyScraper                   │
              │   · 인코딩 판별 및 디코딩              │
              │   · 6개 파서 순차 시도                │
              │   · 유효 범위 검사                    │
              └──────────────┬─────────────────────┘
                             │ 재시도 (1s / 3s / 10s)
                             ▼
              ┌────────────────────────────────────┐
              │  ExchangeRateService  [mutex]      │
              │   · 전회 대비 계산 (정수 연산)          │
              │   · 당일 고가/저가 (Asia/Seoul 기준)    │
              └──────────────┬─────────────────────┘
                             │ ① SQLite 저장 성공 후에만
                             ▼
              ┌────────────────────────────────────┐
              │  SQLite  (rates / app_settings /   │
              │           health_events)           │
              └──────────────┬─────────────────────┘
                             │ ② 외부 서비스 갱신 (서로 격리)
                  ┌──────────┴──────────┐
                  ▼                     ▼
        ┌───────────────────┐  ┌───────────────────┐
        │  Discord          │  │  Notion           │
        │   상태 메시지 수정     │  │   상태 행 갱신        │
        │   슬래시 커맨드 4종    │  │   이력 행 (선택)      │
        └───────────────────┘  └───────────────────┘
```

**핵심 원칙**: SQLite 저장이 성공해야 외부 서비스로 나갑니다. Discord와 Notion은 서로 독립적으로 실패할 수 있고, 어느 쪽이 실패해도 수집 루프는 계속 돕니다.

### 디렉터리 구조

```text
yenwatch/
├── src/
│   ├── index.ts              진입점 (환경변수 검증, 시그널 처리)
│   ├── app.ts                의존성 조립 및 종료 처리
│   ├── logger.ts             Pino 구조화 로깅
│   ├── errors.ts             에러 타입 (재시도 가능 여부 포함)
│   ├── version.ts
│   ├── config/env.ts         Zod 환경변수 검증
│   ├── cli/                  npm run cli 관리 도구
│   ├── discord/              클라이언트, Embed, 상태 메시지, 슬래시 커맨드
│   ├── notion/               클라이언트, 스키마 검증, 상태/이력 저장소
│   ├── scraper/              네이버 파서 (parsers.ts / naverJpyScraper.ts)
│   ├── database/             연결, 마이그레이션, 4개 저장소(환율/설정/헬스/알림)
│   ├── services/             환율/헬스/알림/목표알림/스케줄러/보존
│   ├── utils/                retry, mutex, sparkline, time, money
│   └── types/
├── tests/                    180개 단위 테스트 + 통합 테스트
├── scripts/                  check-health, register-discord-commands, setup-notion, backup-db
├── deploy/                   install-pm2.sh, install.sh, yenwatch.service, backup.sh
├── ecosystem.config.cjs      pm2 프로세스 정의 (fork 모드, 단일 인스턴스)
├── data/                     SQLite 파일 (git 제외)
└── logs/                     pm2 로그 (git 제외)
```

---

## 4. 요구사항

| 항목            | 최소                                | 권장                      |
| --------------- | ----------------------------------- | ------------------------- |
| Node.js         | 20.11                               | 22 LTS                    |
| OS              | Linux / macOS / Windows             | Raspberry Pi OS 64-bit    |
| 하드웨어        | 라즈베리파이 3 이상                 | 라즈베리파이 4 (2GB+)     |
| 저장 공간       | 500 MB                              | 2 GB 이상                 |
| 계정            | Discord 계정, 관리 권한이 있는 서버 | + Notion 계정             |
| 프로세스 관리자 | pm2 또는 systemd                    | pm2 (`sudo npm i -g pm2`) |

> **Notion은 선택 사항입니다.** `.env`에서 `NOTION_ENABLED=false`로 두면 Discord와 SQLite만 사용합니다.

---

## 5. Discord 봇 만들기

### 5.1 애플리케이션 생성

1. <https://discord.com/developers/applications> 접속 후 로그인합니다.
2. 오른쪽 위 **New Application** 버튼을 누릅니다.
3. 이름에 `YenWatch`를 입력하고 약관에 동의한 뒤 **Create**를 누릅니다.
4. **General Information** 탭에서 아이콘을 업로드합니다. (선택)
5. 같은 화면의 **APPLICATION ID** 아래 **Copy** 버튼을 누릅니다.
6. 이 값이 `.env`의 `DISCORD_CLIENT_ID`입니다.

### 5.2 봇 토큰 발급

1. 왼쪽 메뉴에서 **Bot**을 클릭합니다.
2. **Reset Token** 버튼을 누릅니다. (계정 2FA가 켜져 있으면 코드를 요구합니다)
3. **Yes, do it!** 을 눌러 확인합니다.
4. 화면에 나타난 토큰을 **Copy** 합니다.
5. 이 값이 `.env`의 `DISCORD_TOKEN`입니다.

> ⚠️ **토큰은 이 화면을 벗어나면 다시 볼 수 없습니다.** 지금 바로 `.env`에 붙여넣으세요.
>
> ⚠️ **토큰은 비밀번호와 같습니다.** 절대 GitHub·Discord·블로그에 올리지 마세요. 실수로 노출했다면 즉시 **Reset Token**으로 재발급하세요.

### 5.3 Gateway Intent 설정

YenWatch는 **일반 메시지 본문을 읽지 않습니다.** 슬래시 커맨드와 채널 메시지 작성만 사용하므로, 특권 Intent가 전혀 필요 없습니다.

**Bot** 탭 아래쪽 **Privileged Gateway Intents**에서 세 항목을 **모두 꺼진 상태로 둡니다.**

| Intent                 | 설정  |
| ---------------------- | ----- |
| Presence Intent        | ❌ 끔 |
| Server Members Intent  | ❌ 끔 |
| Message Content Intent | ❌ 끔 |

> 봇 코드는 `GatewayIntentBits.Guilds` 하나만 사용합니다. (`src/discord/client.ts`)

---

## 6. Discord 서버에 초대하기

### 6.1 초대 URL 만들기

1. 왼쪽 메뉴에서 **OAuth2** → **URL Generator**를 클릭합니다.
2. **SCOPES**에서 두 개를 체크합니다.

   ```text
   ✅ bot
   ✅ applications.commands
   ```

3. 아래에 나타나는 **BOT PERMISSIONS**에서 다음 5개만 체크합니다.

   ```text
   ✅ View Channels
   ✅ Send Messages
   ✅ Embed Links
   ✅ Read Message History
   ✅ Use Application Commands
   ```

   > ❌ **Administrator는 절대 체크하지 마세요.** 필요한 최소 권한만 부여하는 것이 안전합니다.

4. 페이지 맨 아래 **GENERATED URL**을 **Copy** 합니다.

### 6.2 서버에 추가

1. 복사한 URL을 브라우저 주소창에 붙여넣고 이동합니다.
2. 봇을 추가할 서버를 선택하고 **계속하기**를 누릅니다.
3. 권한 목록을 확인하고 **승인**을 누릅니다.
4. 서버 멤버 목록에 `YenWatch`가 오프라인 상태로 나타나면 성공입니다.

---

## 7. Discord 권한 설정

### 7.1 개발자 모드 켜기

ID를 복사하려면 개발자 모드가 필요합니다.

1. Discord 앱에서 왼쪽 아래 **⚙️ 사용자 설정**을 클릭합니다.
2. **고급** 메뉴로 이동합니다.
3. **개발자 모드**를 켭니다.

### 7.2 필요한 ID 복사하기

| 값           | 복사 방법                                            | 넣을 곳                    |
| ------------ | ---------------------------------------------------- | -------------------------- |
| 서버 ID      | 서버 아이콘 **우클릭** → **서버 ID 복사하기**        | `DISCORD_GUILD_ID`         |
| 채널 ID      | 환율을 표시할 채널 **우클릭** → **채널 ID 복사하기** | `DISCORD_CHANNEL_ID`       |
| 내 사용자 ID | 내 프로필 **우클릭** → **사용자 ID 복사하기**        | `DISCORD_ALLOWED_USER_IDS` |

> 💡 환율 전용 채널(예: `#환율`)을 하나 새로 만드는 것을 권장합니다. 상태 메시지가 다른 대화에 묻히지 않습니다.

### 7.3 채널 권한 확인

봇 역할이 해당 채널에서 다음을 할 수 있어야 합니다.

- 채널 보기
- 메시지 보내기
- 링크 첨부 (Embed 표시에 필요)
- 메시지 기록 보기 (기존 상태 메시지를 찾는 데 필요)

비공개 채널을 쓴다면 **채널 편집 → 권한**에서 `YenWatch` 역할을 추가하고 위 권한을 허용하세요.

---

## 8. Notion Integration 만들기

> Notion을 쓰지 않으려면 이 장과 다음 장을 건너뛰고 `.env`에 `NOTION_ENABLED=false`를 넣으세요.

1. <https://www.notion.so/my-integrations> 에 접속합니다.
2. **New integration**을 누릅니다.
3. 다음과 같이 입력합니다.
   - **Name**: `YenWatch`
   - **Associated workspace**: 사용할 워크스페이스 선택
   - **Type**: `Internal`
4. **Save**를 누릅니다.
5. **Configuration** 탭의 **Capabilities**에서 세 가지를 켭니다.

   ```text
   ✅ Read content
   ✅ Update content
   ✅ Insert content
   ```

   > 사용자 정보는 필요 없으므로 **User Information** 은 `No user information` 으로 둡니다.

6. **Internal Integration Secret**의 **Show** → **Copy**를 누릅니다.
7. 이 값이 `.env`의 `NOTION_TOKEN`입니다. (`ntn_` 또는 `secret_`으로 시작)

---

## 9. Notion 데이터베이스 만들기

### 9.1 상태 데이터베이스 생성

1. Notion에서 새 페이지를 만듭니다.
2. `/table` 을 입력하고 **Table view**(표 - 전체 페이지)를 선택합니다.
3. 표 이름을 `YenWatch 환율`로 정합니다.
4. 다음 속성을 만듭니다. **이름과 타입이 정확히 일치해야 합니다.** (대소문자, 공백 포함)

   | 속성명           | Notion 타입 | 설명                                                           |
   | ---------------- | ----------- | -------------------------------------------------------------- |
   | `Name`           | Title       | 기본으로 있는 제목 열입니다. 이름이 다르면 `Name`으로 바꾸세요 |
   | `Rate`           | Number      | 100엔당 원화                                                   |
   | `Change`         | Number      | 전회 대비 변화량                                               |
   | `Change Percent` | Number      | 전회 대비 변화율                                               |
   | `Daily High`     | Number      | 당일 최고                                                      |
   | `Daily Low`      | Number      | 당일 최저                                                      |
   | `Collected At`   | Date        | 수집 시각                                                      |
   | `Status`         | Select      | 정상 또는 오류                                                 |
   | `Source`         | URL         | 네이버 금융 URL                                                |

   > 속성 추가는 표 오른쪽 끝의 **+** 버튼을 누르고 이름 입력 → 타입 선택 순서입니다.
   >
   > `Status`(Select)의 옵션은 봇이 처음 쓸 때 `정상` / `오류`를 자동으로 만듭니다. 미리 만들어 둬도 됩니다.

### 9.2 Integration 연결

1. 데이터베이스 페이지 오른쪽 위 **⋯** 을 누릅니다.
2. **연결**(Connections) → **연결 추가**를 선택합니다.
3. 목록에서 `YenWatch`를 선택하고 **확인**합니다.

> 이 단계를 빠뜨리면 API가 `object_not_found` 오류를 냅니다. 가장 흔한 실수입니다.

### 9.3 data source ID 복사하기 ⚠️ 중요

Notion API는 2025년 9월부터 **database ID**와 **data source ID**를 구분합니다. YenWatch는 **data source ID**를 사용합니다.

**방법 1 — URL에서 확인 (가장 쉬움)**

데이터베이스를 전체 페이지로 열면 주소창이 이런 모양입니다.

```text
https://www.notion.so/myworkspace/1a2b3c4d5e6f7890abcdef1234567890?v=...
                                  └──────────── 32자리 ────────────┘
```

이 32자리 문자열이 **database ID**입니다. 대부분의 단순 데이터베이스는 data source가 하나뿐이고, 이 경우 아래 방법 2로 정확한 값을 확인하는 것이 가장 확실합니다.

**방법 2 — API로 확인 (정확함)**

`NOTION_TOKEN`을 `.env`에 넣은 뒤 실행하세요.

```bash
curl -s -X POST https://api.notion.com/v1/search \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2025-09-03" \
  -H "Content-Type: application/json" \
  -d '{"filter":{"property":"object","value":"data_source"}}' \
  | python3 -m json.tool | grep -A2 '"id"' | head -20
```

응답에서 `"object": "data_source"` 항목의 `id` 값이 `NOTION_DATA_SOURCE_ID`입니다.

**연결 및 스키마 확인**

값을 `.env`에 넣은 뒤 다음 명령으로 검증하세요.

```bash
npm run notion:check
```

출력 예시:

```text
✓ 연결 성공 — integration: YenWatch

[상태 데이터베이스] Notion 데이터 소스 스키마 점검
  제목      : YenWatch 환율
  ID        : 1a2b3c4d-5e6f-7890-abcd-ef1234567890

  실제 속성 목록:
    - Name  (title)
    - Rate  (number)
    - Change  (number)
    ...

  ✓ 모든 필수 속성이 올바르게 설정되어 있습니다.
```

속성이 잘못됐다면 **무엇이 빠졌고 어떤 타입이어야 하는지** 그대로 알려줍니다.

### 9.4 이력 데이터베이스 (선택)

환율 변화를 Notion에 누적하고 싶다면 데이터베이스를 하나 더 만듭니다.

- 속성은 상태 DB와 같지만 **`Status`는 필요 없습니다.**
- 같은 방법으로 integration을 연결하고 data source ID를 복사합니다.
- `.env`에 다음을 설정합니다.

  ```env
  NOTION_HISTORY_ENABLED=true
  NOTION_HISTORY_DATA_SOURCE_ID=여기에_붙여넣기
  NOTION_HISTORY_INTERVAL_MINUTES=60
  ```

> ⚠️ 1분마다 이력 행을 만들면 **하루 1,440개, 1년이면 52만 개**가 됩니다. 기본값 60분(하루 24개)을 권장합니다. 분 단위 전체 데이터는 SQLite에 이미 저장됩니다.

---

## 10. 로컬 개발 환경 설정

```bash
# 1. 저장소 받기
git clone <REPOSITORY_URL> yenwatch
cd yenwatch

# 2. 의존성 설치
npm install

# 3. .env 만들기
cp .env.example .env
chmod 600 .env          # Windows에서는 생략

# 4. 값 채우기 (대화형 도구 권장)
npm run cli
```

`npm run cli`를 실행하면 다음 메뉴가 나옵니다.

```text
───────────────────────────────
  YenWatch 관리 도구 v1.0.0
───────────────────────────────
  프로젝트 경로  C:\...\yenwatch
  .env 파일     C:\...\yenwatch\.env
  Node.js      v22.11.0

무엇을 할까요?
   0. 종료
   1. .env 파일 만들기 (.env.example 기반)
   2. 환경변수 편집 (그룹 선택)
   3. 환경변수 값 보기 / 권한 확인
   4. 환경변수 검증
   5. 환율 수집 테스트 (네이버 실제 호출)
   6. Discord 슬래시 커맨드 등록
   7. Notion 연결 및 스키마 점검
   8. SQLite 상태 보기
   9. SQLite 백업
  10. 데이터 보존 정책 즉시 실행
  11. systemd 서비스 명령 안내
```

**2번**을 고르면 항목마다 "어디서 값을 구하는지" 설명과 현재 값(비밀은 마스킹)을 보여주며 하나씩 물어봅니다. 값을 저장하면 즉시 검증 결과도 알려줍니다.

### 비대화형 명령

SSH 접속이나 스크립트에서는 다음을 사용하세요.

```bash
npm run cli -- status              # 전체 상태 요약
npm run cli -- check               # 환경변수 검증 (실패 시 exit 1)
npm run cli -- env                 # 환경변수 값 보기 (마스킹)
npm run cli -- set DISCORD_CHANNEL_ID 123456789012345678
npm run cli -- scrape              # 네이버 수집 테스트 (저장 안 함)
npm run cli -- scrape --save       # 수집 후 SQLite 저장
npm run cli -- notion              # Notion 점검
npm run cli -- discord:register    # 슬래시 커맨드 등록
npm run cli -- db                  # SQLite 상태
npm run cli -- backup              # 온라인 백업
npm run cli -- retention           # 보존 정책 즉시 실행
npm run cli -- service             # systemd 명령 안내
```

> 💡 **수집 테스트(`scrape`)는 Discord/Notion 설정 없이도 동작합니다.** 가장 먼저 이걸로 네트워크와 파서를 확인하세요.

---

## 11. 환경변수 설명

전체 목록은 `.env.example`에 있습니다. 아래는 각 값의 의미입니다.

### 실행 환경

| 변수        | 기본값       | 설명                                                     |
| ----------- | ------------ | -------------------------------------------------------- |
| `NODE_ENV`  | `production` | `production`이면 JSON 로그, 아니면 사람이 읽기 쉬운 로그 |
| `TZ`        | `Asia/Seoul` | 표시 기준 시간대                                         |
| `LOG_LEVEL` | `info`       | `trace` / `debug` / `info` / `warn` / `error` / `fatal`  |

### Discord (필수)

| 변수                       | 필수 | 설명                                                                 |
| -------------------------- | ---- | -------------------------------------------------------------------- |
| `DISCORD_TOKEN`            | ✅   | 봇 토큰. Developer Portal → Bot → Reset Token                        |
| `DISCORD_CLIENT_ID`        | ✅   | Application ID                                                       |
| `DISCORD_GUILD_ID`         | ✅   | 서버 ID. 슬래시 커맨드를 이 서버에 즉시 등록                         |
| `DISCORD_CHANNEL_ID`       | ✅   | 상태 메시지를 표시할 채널 ID                                         |
| `DISCORD_ALLOWED_USER_IDS` |      | `/yen-refresh` 허용 사용자. **쉼표로 구분.** 비우면 아무도 실행 불가 |

### Notion

| 변수                              | 기본값  | 설명                                            |
| --------------------------------- | ------- | ----------------------------------------------- |
| `NOTION_ENABLED`                  | `true`  | `false`면 Notion 없이 Discord + SQLite만 사용   |
| `NOTION_TOKEN`                    |         | Internal Integration Secret                     |
| `NOTION_DATA_SOURCE_ID`           |         | 상태 DB의 **data source ID** (database ID 아님) |
| `NOTION_STATUS_PAGE_ID`           |         | 비우면 자동 탐색/생성 후 SQLite에 기억          |
| `NOTION_HISTORY_ENABLED`          | `false` | 이력 기록 사용 여부                             |
| `NOTION_HISTORY_DATA_SOURCE_ID`   |         | 이력 DB의 data source ID                        |
| `NOTION_HISTORY_INTERVAL_MINUTES` | `60`    | 이력 행 생성 주기(분)                           |

### 수집

| 변수                      | 기본값           | 설명                                            |
| ------------------------- | ---------------- | ----------------------------------------------- |
| `NAVER_JPY_URL`           | 네이버 엔화 상세 | 보통 기본값 그대로 사용                         |
| `SCRAPE_INTERVAL_SECONDS` | `60`             | 수집 주기(초). 너무 짧으면 차단될 수 있습니다   |
| `REQUEST_TIMEOUT_MS`      | `10000`          | HTTP 타임아웃                                   |
| `STALE_AFTER_MINUTES`     | `5`              | 이 시간을 넘기면 Discord에 "오래된 데이터" 경고 |
| `FAILURE_ALERT_THRESHOLD` | `5`              | 연속 실패 이 횟수에 경고 1회 발송               |
| `MIN_VALID_JPY100_KRW`    | `100`            | 유효 최소값 (100 JPY 당 KRW)                    |
| `MAX_VALID_JPY100_KRW`    | `2000`           | 유효 최대값                                     |
| `ALERT_REARM_MARGIN_KRW`  | `1`              | 알림이 울린 뒤 재무장에 필요한 여유폭(KRW)      |

### 저장소

| 변수                  | 기본값               | 설명                                               |
| --------------------- | -------------------- | -------------------------------------------------- |
| `SQLITE_PATH`         | `./data/yenwatch.db` | DB 파일 경로                                       |
| `DATA_RETENTION_DAYS` | `365`                | 이보다 오래된 데이터는 매일 04:10(KST)에 자동 삭제 |

---

## 12. 실행 및 테스트

### 12.1 설정 검증

```bash
npm run check
```

환경변수 → SQLite → 네이버 수집 → Discord 로그인/채널 권한 → Notion 연결/스키마를 **실제로** 확인합니다.

```text
✓ 환경변수 — 모든 필수 값이 올바릅니다
✓ SQLite — 정상 (0건, ./data/yenwatch.db)
✓ 네이버 환율 수집 — 100 JPY = 888.22 KRW (파서: no_today_text, 87ms)
✓ Discord 로그인 — YenWatch#1234 (id=...)
✓ Discord 채널 접근 — #환율 에 메시지를 보낼 수 있습니다
✓ Notion 연결 — integration: YenWatch
✓ Notion 상태 스키마 — "YenWatch 환율" 속성 9개 확인
```

실패한 항목이 있으면 exit code 1을 반환합니다.

### 12.2 슬래시 커맨드 등록

```bash
npm run discord:register
```

`DISCORD_GUILD_ID` 서버에 **길드 커맨드**로 등록되어 **즉시** 반영됩니다.

```bash
npm run discord:register -- --global   # 글로벌 등록 (반영까지 최대 1시간)
npm run discord:register -- --clear    # 등록된 커맨드 전체 삭제
```

### 12.3 개발 모드 실행

```bash
npm run dev      # 파일 변경 시 자동 재시작, 사람이 읽기 좋은 로그
```

### 12.4 프로덕션 실행

포그라운드로 한 번 띄워 확인:

```bash
npm run build
npm start                # Ctrl+C 로 종료
```

pm2로 상주 실행:

```bash
npm run build
npm run pm2:start        # = pm2 start ecosystem.config.cjs
pm2 save                 # 재부팅 후에도 뜨도록 목록 저장
pm2 logs yenwatch
```

### 12.5 테스트

```bash
npm test                 # 단위 테스트 (fixture 기반, 네트워크 불필요) — 180개
npm run test:watch       # 감시 모드
npm run test:integration # 통합 테스트 (실제 네이버 호출)
```

통합 테스트는 `RUN_INTEGRATION_TESTS=true`일 때만 실행되므로 기본 CI에서는 돌지 않습니다.

### 12.6 코드 품질

```bash
npm run lint          # ESLint
npm run typecheck     # 타입 검사만
npm run format        # Prettier 자동 정렬
npm run format:check  # 정렬 확인만
```

### 12.7 슬래시 커맨드 사용법

| 커맨드                    | 설명                                                             | 응답       |
| ------------------------- | ---------------------------------------------------------------- | ---------- |
| `/yen`                    | 현재 환율, 전회 대비, 당일 최고·최저, 최근 수집 시각             | 채널 공개  |
| `/yen-history period:24h` | 기간 통계 + 텍스트 스파크라인 (`1h`/`6h`/`12h`/`24h`/`7d`)       | 채널 공개  |
| `/yen-status`             | 실행 시간, Discord·Notion·SQLite 상태, 실패 횟수, 다음 수집 예정 | **본인만** |
| `/yen-refresh`            | 즉시 재수집 (허용 사용자만, 30초 쿨다운)                         | **본인만** |
| `/yen-alert add`          | 목표 환율 알림 등록                                              | **본인만** |
| `/yen-alert list`         | 등록된 알림 목록                                                 | **본인만** |
| `/yen-alert remove`       | 알림 삭제                                                        | **본인만** |

#### 목표 환율 알림 사용법

```text
/yen-alert add rate:940 direction:아래로
        → 100 JPY 가 940 KRW 이하로 내려가면 나를 멘션

/yen-alert add rate:960 direction:위로 once:true
        → 960 KRW 이상 올라가면 한 번만 알리고 종료

/yen-alert add rate:935 direction:아래로 user:@친구 label:여행 경비
        → 친구를 멘션 (DISCORD_ALLOWED_USER_IDS 권한 필요)

/yen-alert list         → 등록된 알림과 상태 확인
/yen-alert remove id:3  → 3번 알림 삭제
```

**한 번 울린 알림이 다시 울리는 조건**

목표선에서 `ALERT_REARM_MARGIN_KRW`(기본 1 KRW) 이상 벗어나야 다시 감시 상태가 됩니다.
1분마다 수집하므로 이 장치가 없으면 환율이 목표선 근처에 머무는 동안
하루 1,440번까지 멘션이 갈 수 있습니다.

```text
목표 "940 이하", margin 1.0 인 경우

939.5  →  🔔 발송, 감시 해제
939.8  →  조건은 맞지만 조용함
940.5  →  아직 재무장 안 됨 (941 미만)
941.2  →  재무장 — 다음에 940 이하로 내려가면 다시 발송
```

권한 규칙:

- **본인 멘션**: 누구나 등록 가능
- **다른 사람 멘션**: `DISCORD_ALLOWED_USER_IDS` 에 포함된 사용자만 (핑 남용 방지)
- **삭제**: 본인이 만든 알림 또는 허용된 사용자

---

## 13. 라즈베리파이 설치

### 13.0 프로세스 관리자 선택

두 가지 방식을 지원합니다. **하나만 고르세요.**

|                | pm2                            | systemd                     |
| -------------- | ------------------------------ | --------------------------- |
| 설치 스크립트  | `deploy/install-pm2.sh`        | `deploy/install.sh`         |
| 실행 권한      | 일반 사용자 (sudo 없이)        | root                        |
| 로그 확인      | `pm2 logs yenwatch`            | `journalctl -u yenwatch -f` |
| 부팅 자동 실행 | `pm2 startup` + **`pm2 save`** | `systemctl enable`          |
| 추가 설치      | 필요 (`npm i -g pm2`)          | 불필요 (OS 기본)            |

> ⚠️ **둘을 동시에 켜면 안 됩니다.** 프로세스가 두 개 뜨면 같은 SQLite 파일에 붙어 `database is locked`가 나고, Discord 상태 메시지를 서로 덮어씁니다. `install-pm2.sh`는 systemd 유닛이 등록돼 있으면 감지해서 비활성화할지 물어봅니다.

아래 13.1은 pm2 기준입니다. systemd를 쓰시려면 [13.4](#134-systemd-로-설치하려면)를 보세요.

### 13.1 자동 설치 — pm2 (권장)

```bash
# 1. 설치 경로 준비
sudo mkdir -p /opt/yenwatch
sudo chown -R "$USER":"$USER" /opt/yenwatch

# 2. 저장소 clone
git clone <REPOSITORY_URL> /opt/yenwatch
cd /opt/yenwatch

# 3. 설치 스크립트 실행 — sudo 없이 일반 사용자로!
chmod +x deploy/*.sh          # Windows 에서 clone 했다면 실행 권한이 없을 수 있습니다
./deploy/install-pm2.sh
```

> ⚠️ **`sudo ./deploy/install-pm2.sh` 로 실행하지 마세요.** pm2는 사용자 단위로 동작합니다. root로 등록하면 나중에 `pm2 status`에 아무것도 안 보여 헷갈립니다. 스크립트가 root 실행을 감지하면 거부합니다. apt 설치와 부팅 등록 때만 sudo를 요청합니다.

`install-pm2.sh`가 자동으로 처리하는 것:

- OS 패키지 설치 (`git curl build-essential python3 make g++ sqlite3`)
- Node.js LTS 설치 (없거나 20 미만일 때만)
- **pm2 + pm2-logrotate 설치** (10MB마다 분할, 14개 보관, 압축)
- 시간대를 `Asia/Seoul`로 설정
- `npm ci` → `npm run build`
- `.env` 생성 및 권한 600 설정
- **systemd 유닛 충돌 감지 및 정리**
- `pm2 startup`으로 부팅 자동 실행 등록

설치가 끝나면 다음을 진행합니다.

```bash
npm run cli                # 설정 입력
npm run check              # 검증
npm run discord:register   # 슬래시 커맨드 등록

npm run pm2:start          # 시작
pm2 save                   # ← 이걸 빠뜨리면 재부팅 후 안 뜹니다
pm2 logs yenwatch          # 확인
```

### 13.2 수동 설치

<details>
<summary>단계별로 직접 하고 싶다면 펼치세요</summary>

**① OS 패키지**

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y git curl build-essential python3 make g++ sqlite3
```

`build-essential`, `python3`, `make`, `g++`는 `better-sqlite3` 네이티브 모듈을 소스에서 빌드해야 할 때 필요합니다. 보통은 미리 컴파일된 바이너리를 내려받지만, ARM64 환경에서 실패하면 이 도구들로 직접 빌드합니다.

**② Node.js LTS**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

설치 확인:

```bash
node --version     # v22.x.x 이상
npm --version      # 10.x.x 이상
uname -m           # aarch64  <- ARM64 64-bit OS
```

> `uname -m`이 `aarch64`면 64-bit OS입니다. `armv7l`이 나오면 32-bit이며, 네이티브 모듈 빌드가 느리고 문제가 생길 수 있습니다. **Raspberry Pi OS 64-bit 사용을 권장합니다.**

**③ 시간대**

```bash
sudo timedatectl set-timezone Asia/Seoul
timedatectl                 # Time zone: Asia/Seoul (KST, +0900) 확인
```

**④ 프로젝트 설치**

```bash
sudo mkdir -p /opt/yenwatch
sudo chown -R "$USER":"$USER" /opt/yenwatch
git clone <REPOSITORY_URL> /opt/yenwatch
cd /opt/yenwatch

npm ci
npm run build

cp .env.example .env
chmod 600 .env
```

**⑤ 설정 및 검증**

```bash
npm run cli                # .env 값 입력
npm run check              # 전체 점검
npm run discord:register   # 슬래시 커맨드 등록
```

</details>

### 13.3 better-sqlite3 빌드 문제 해결

`npm ci` 중 `better-sqlite3`에서 오류가 나면:

```bash
# 1. 빌드 도구가 있는지 확인
sudo apt install -y build-essential python3 make g++

# 2. 캐시를 지우고 소스에서 다시 빌드
cd /opt/yenwatch
rm -rf node_modules package-lock.json
npm install --build-from-source better-sqlite3
npm install
```

라즈베리파이 3처럼 메모리가 적은 기기에서 빌드가 멈춘다면 스왑을 임시로 늘리세요.

```bash
sudo dphys-swapfile swapoff
sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile
sudo dphys-swapfile setup
sudo dphys-swapfile swapon

# 빌드 후 원래대로 되돌리기 (SD 카드 수명 보호)
sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=100/' /etc/dphys-swapfile
sudo dphys-swapfile setup && sudo dphys-swapfile swapon
```

### 13.4 systemd 로 설치하려면

pm2 대신 systemd를 쓰고 싶다면 이쪽입니다. (pm2가 이미 등록돼 있다면 먼저 `pm2 delete yenwatch && pm2 save`로 정리하세요.)

```bash
cd /opt/yenwatch
chmod +x deploy/*.sh
sudo ./deploy/install.sh
```

`install.sh`는 실행 사용자와 `which node` 경로를 자동 감지해 서비스 파일에 치환하고, `daemon-reload` + `enable`까지 처리합니다. 자세한 운영 명령은 [14.7](#147-systemd-대안-서비스-설치)을 보세요.

---

## 14. 자동 실행 설정

### 14.1 pm2 등록

`install-pm2.sh`를 썼다면 이미 끝났습니다. 수동으로 하려면:

```bash
cd /opt/yenwatch
sudo npm install -g pm2

npm run build                          # dist/ 가 있어야 합니다
npm run pm2:start                      # = pm2 start ecosystem.config.cjs
pm2 save                               # 현재 목록 저장
```

설정은 `ecosystem.config.cjs`에 들어 있습니다. 경로·사용자를 직접 고칠 필요가 없습니다 (`cwd: __dirname`).

> 🔑 **토큰은 `ecosystem.config.cjs`에 넣지 마세요.** 이 파일은 Git에 커밋됩니다. 앱이 시작할 때 `cwd`의 `.env`를 직접 읽으므로, 값은 전부 `.env`에만 두면 됩니다.

### 14.2 부팅 자동 실행

pm2에서 재부팅 후 봇이 안 뜨는 원인은 거의 항상 **`pm2 save`를 안 한 것**입니다. 두 단계 모두 필요합니다.

```bash
# ① pm2 데몬 자체를 부팅 시 띄우도록 등록 (한 번만)
pm2 startup systemd
# → 화면에 sudo 로 시작하는 명령이 출력되면 그대로 복사해서 실행하세요

# ② 지금 실행 중인 프로세스 목록을 스냅샷으로 저장
pm2 save
```

`pm2 startup`은 `pm2-<사용자>.service`라는 systemd 유닛을 만들어, 부팅 시 pm2 데몬과 **`pm2 save`로 저장된 목록**을 복원합니다. 저장을 안 하면 데몬만 뜨고 앱은 안 뜹니다.

확인:

```bash
systemctl is-enabled pm2-$USER        # enabled
cat ~/.pm2/dump.pm2 | head -5         # yenwatch 가 들어 있어야 합니다
```

> 프로세스 구성을 바꿀 때마다(`pm2 start` / `delete` / `ecosystem.config.cjs` 수정 후 재시작) **`pm2 save`를 다시 실행**하세요.

### 14.3 상태 확인

```bash
pm2 status                  # 전체 목록
pm2 describe yenwatch       # 상세 (재시작 횟수, 메모리, uptime, 로그 경로)
pm2 monit                   # 실시간 대시보드
```

정상이면 이렇게 보입니다.

```text
┌────┬───────────┬─────────┬─────────┬─────────┬──────────┬────────┬──────┬───────────┐
│ id │ name      │ mode    │ ↺       │ status  │ cpu      │ memory │      │           │
├────┼───────────┼─────────┼─────────┼─────────┼──────────┼────────┼──────┼───────────┤
│ 0  │ yenwatch  │ fork    │ 0       │ online  │ 0%       │ 78.2mb │      │           │
└────┴───────────┴─────────┴─────────┴─────────┴──────────┴────────┴──────┴───────────┘
```

`status`가 `online`이고 `↺`(재시작 횟수)가 계속 늘지 않으면 정상입니다. 숫자가 계속 오르면 앱이 죽고 되살아나기를 반복하는 것이니 `pm2 logs yenwatch --err`를 확인하세요.

### 14.4 운영 명령

```bash
npm run pm2:restart      # 재시작 (= pm2 restart yenwatch --update-env)
npm run pm2:stop         # 중지 (목록에는 남음)
npm run pm2:delete       # 목록에서 제거 (이후 pm2 save 필요)
npm run pm2:logs         # 로그
npm run pm2:status       # 상세 상태

pm2 restart yenwatch     # npm 없이 직접
pm2 flush yenwatch       # 로그 파일 비우기
```

> `.env`를 고친 뒤에는 **`--update-env`가 붙은 재시작**을 쓰세요. `npm run pm2:restart`에 이미 포함돼 있습니다. 그냥 `pm2 restart`만 하면 pm2가 이전 환경변수를 그대로 물려줍니다.

### 14.5 재부팅 후 확인

```bash
sudo reboot

# 재부팅 후 약 1분 뒤 접속
pm2 status                     # yenwatch 가 online
pm2 logs yenwatch --lines 30
```

Discord 채널의 상태 메시지가 계속 갱신되면 정상입니다.

만약 목록이 비어 있다면:

```bash
pm2 resurrect                  # 저장된 목록 즉시 복원
pm2 save                       # 다시 저장
systemctl status pm2-$USER     # 데몬 유닛이 활성인지 확인
```

### 14.6 ecosystem.config.cjs 에서 하는 일

| 설정                                    | 이유                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `exec_mode: 'fork'`, `instances: 1`     | **필수.** cluster 모드로 여러 개 띄우면 SQLite가 잠기고 Discord 메시지가 충돌합니다       |
| `kill_timeout: 30000`                   | 앱이 진행 중인 수집을 끝내고 SQLite를 안전하게 닫을 시간 확보                             |
| `restart_delay: 10000`                  | 죽으면 10초 뒤 재시작 (네트워크 복구 여유)                                                |
| `max_restarts: 10`, `min_uptime: '60s'` | 1분 내 10회 넘게 죽으면 설정 오류로 보고 재시작 포기                                      |
| `max_memory_restart: '300M'`            | 라즈베리파이 보호용 안전장치 (정상 시 100MB 미만)                                         |
| `time: false`                           | pino가 이미 타임스탬프를 붙입니다. 켜면 JSON 로그 앞에 텍스트가 붙어 `jq` 파싱이 깨집니다 |
| `watch: false`                          | 켜면 `data/*.db` 쓰기마다 재시작되어 봇이 사실상 못 돕니다                                |
| `cwd: __dirname`                        | 앱이 이 경로의 `.env`와 `data/`를 찾습니다                                                |

---

## 14-B. systemd (대안)

<details>
<summary>pm2 대신 systemd를 쓴다면 펼치세요</summary>

### 14.7 systemd 대안 — 서비스 설치

`install.sh`를 썼다면 이미 끝났습니다. 수동으로 하려면:

```bash
sudo cp /opt/yenwatch/deploy/yenwatch.service /etc/systemd/system/yenwatch.service
```

**설치 전에 다음 세 줄을 실제 환경에 맞게 수정하세요.**

```bash
which node          # 예: /usr/bin/node  또는  /home/pi/.nvm/versions/node/v22.11.0/bin/node
whoami              # 예: pi
```

```ini
User=pi                                          # whoami 결과
Group=pi                                         # 같은 값
ExecStart=/usr/bin/node /opt/yenwatch/dist/index.js   # which node 결과
```

편집:

```bash
sudo nano /etc/systemd/system/yenwatch.service
```

### 14.8 systemd 대안 — 활성화 및 시작

```bash
sudo systemctl daemon-reload
sudo systemctl enable yenwatch
sudo systemctl start yenwatch
```

### 14.9 systemd 대안 — 상태 확인

```bash
sudo systemctl status yenwatch
```

정상이면 이렇게 보입니다.

```text
● yenwatch.service - YenWatch Discord and Notion Exchange Rate Bot
     Loaded: loaded (/etc/systemd/system/yenwatch.service; enabled; preset: enabled)
     Active: active (running) since Wed 2026-07-29 23:45:01 KST; 2min ago
   Main PID: 1234 (node)
```

`enabled`와 `active (running)` 두 가지를 확인하세요.

### 14.10 systemd 대안 — 운영 명령

```bash
sudo systemctl restart yenwatch      # 재시작
sudo systemctl stop yenwatch         # 중지
sudo systemctl disable yenwatch      # 부팅 자동 실행 해제
systemctl is-enabled yenwatch        # 자동 실행 여부 확인 -> enabled
systemctl is-active yenwatch         # 실행 중인지 확인 -> active
```

### 14.11 systemd 대안 — 부팅 자동 실행 확인

```bash
# 1. 등록 확인
systemctl is-enabled yenwatch        # enabled 가 나와야 합니다

# 2. 실제로 재부팅해서 확인
sudo reboot

# 3. 재부팅 후 (약 1분 뒤 접속)
systemctl is-active yenwatch         # active
journalctl -u yenwatch -b            # 이번 부팅의 로그 전체
```

Discord 채널의 상태 메시지가 계속 갱신되면 정상입니다.

### 14.12 systemd 대안 — 서비스 유닛에서 하는 일

| 설정                                                               | 이유                                                |
| ------------------------------------------------------------------ | --------------------------------------------------- |
| `After/Wants=network-online.target`                                | 부팅 직후 DNS 실패 방지                             |
| `Restart=on-failure` / `RestartSec=10`                             | 비정상 종료 시 10초 뒤 자동 재시작                  |
| `StartLimitBurst=5`                                                | 5분 내 5회 실패하면 재시작 중단 (무한 루프 방지)    |
| `KillSignal=SIGTERM` / `TimeoutStopSec=30`                         | 앱이 수집을 마치고 SQLite를 안전하게 닫을 시간 확보 |
| `NoNewPrivileges` / `ProtectSystem=full` / `ProtectHome=read-only` | 권한 상승 및 시스템 파일 쓰기 차단                  |
| `ReadWritePaths=/opt/yenwatch/data`                                | DB 디렉터리만 쓰기 허용                             |

</details>

---

## 15. 로그 확인

```bash
pm2 logs yenwatch                  # 실시간 (Ctrl+C 로 종료)
pm2 logs yenwatch --lines 100      # 최근 100줄
pm2 logs yenwatch --err            # 오류 스트림만
pm2 logs yenwatch --out            # 표준 출력만
pm2 flush yenwatch                 # 로그 비우기
```

로그 파일은 프로젝트의 `logs/` 아래에 쌓입니다. (`ecosystem.config.cjs`에서 지정)

```bash
tail -f /opt/yenwatch/logs/yenwatch-out.log
tail -f /opt/yenwatch/logs/yenwatch-error.log
```

<details>
<summary>systemd 를 쓴다면</summary>

```bash
journalctl -u yenwatch -f              # 실시간
journalctl -u yenwatch --since today   # 오늘
journalctl -u yenwatch -n 100          # 최근 100줄
journalctl -u yenwatch -b              # 이번 부팅 이후 전체
journalctl -u yenwatch -p err          # 오류만
```

</details>

### 15.1 로그 형식

프로덕션에서는 JSON 한 줄 로그를 씁니다.

```json
{
  "level": "info",
  "time": "2026-07-29T14:45:00.182Z",
  "component": "exchange-rate",
  "event": "rate_collected",
  "rate": 946.32,
  "change": 1.24,
  "changePercent": 0.13,
  "parser": "no_today_text",
  "trigger": "schedule",
  "durationMs": 182,
  "collectedAt": "2026-07-29T14:45:00.000Z",
  "msg": "환율 수집 완료"
}
```

`jq`로 보기 좋게 만들 수 있습니다.

`jq`로 보기 좋게 만들 수 있습니다. (`ecosystem.config.cjs`에서 `time: false`로 둔 이유가 이것입니다 — pm2가 시간 접두사를 붙이면 JSON이 깨져 `jq`가 못 읽습니다.)

```bash
sudo apt install -y jq
tail -f logs/yenwatch-out.log | jq -r '"\(.time) [\(.level)] \(.event // "-") \(.msg)"'
```

특정 이벤트만 보기:

```bash
jq -c 'select(.event == "rate_collection_failed")' logs/yenwatch-out.log
jq -c 'select(.event == "rate_collected") | {time, rate, change}' logs/yenwatch-out.log | tail -20
```

### 15.2 이벤트 목록

| 이벤트                                                | 의미                           |
| ----------------------------------------------------- | ------------------------------ |
| `app_started`                                         | 앱 시작                        |
| `discord_connected`                                   | Discord 로그인 성공            |
| `discord_message_created` / `discord_message_updated` | 상태 메시지 생성/수정          |
| `notion_connected`                                    | Notion 연결 확인               |
| `notion_page_created` / `notion_page_updated`         | Notion 상태 페이지 생성/갱신   |
| `rate_collection_started`                             | 수집 시작                      |
| `rate_collected`                                      | 수집 성공                      |
| `rate_collection_failed`                              | 수집 실패                      |
| `rate_collection_skipped`                             | 이전 작업이 진행 중이라 건너뜀 |
| `failure_alert_sent`                                  | 연속 실패 경고 발송            |
| `service_recovered`                                   | 복구                           |
| `retention_completed`                                 | 데이터 정리 완료               |
| `shutdown_started` / `shutdown_completed`             | 종료 절차                      |

### 15.3 로그 용량 관리

1분마다 로그를 남기므로 회전 설정이 없으면 SD 카드가 금방 찹니다. `install-pm2.sh`가 `pm2-logrotate`를 설치하고 아래 값으로 설정합니다.

```bash
pm2 install pm2-logrotate                      # 이미 설치돼 있으면 생략
pm2 set pm2-logrotate:max_size 10M             # 10MB 마다 분할
pm2 set pm2-logrotate:retain 14                # 14개 보관
pm2 set pm2-logrotate:compress true            # 오래된 파일 gzip 압축

pm2 conf pm2-logrotate                         # 현재 설정 확인
```

수동 정리:

```bash
pm2 flush yenwatch                             # 로그 파일 비우기
du -sh /opt/yenwatch/logs                      # 용량 확인
```

<details>
<summary>systemd 를 쓴다면 (journald)</summary>

```bash
sudo journalctl --vacuum-size=200M     # 200MB로 제한
sudo journalctl --vacuum-time=30d      # 30일 이전 삭제
```

영구 설정은 `/etc/systemd/journald.conf`에서:

```ini
SystemMaxUse=200M
MaxRetentionSec=30day
```

</details>

---

## 16. 업데이트 방법

```bash
cd /opt/yenwatch

# 1. 백업 먼저 (권장)
npm run backup

# 2. 코드 받기
git pull

# 3. 의존성 및 빌드
npm ci
npm run build

# 4. 테스트
npm test

# 5. 재시작
npm run pm2:restart

# 6. 확인
pm2 status
pm2 logs yenwatch --lines 30
```

2~5번을 한 번에 하려면:

```bash
cd /opt/yenwatch && git pull && npm run deploy:pm2
```

`deploy:pm2`는 `npm ci` → `npm run build` → `pm2 startOrRestart --update-env` → `pm2 save`를 순서대로 실행합니다.

슬래시 커맨드 정의가 바뀐 업데이트라면 한 번 더 등록하세요.

```bash
npm run discord:register
```

> DB 스키마 변경은 앱 시작 시 자동으로 적용됩니다(`PRAGMA user_version` 기반 마이그레이션). 기존 데이터는 유지됩니다.
>
> `ecosystem.config.cjs`가 바뀐 업데이트라면 재시작 후 **`pm2 save`**를 실행하세요.

### 롤백

```bash
cd /opt/yenwatch
git log --oneline -10          # 되돌아갈 커밋 확인
git checkout <커밋해시>
npm ci && npm run build
npm run pm2:restart
```

<details>
<summary>systemd 를 쓴다면</summary>

```bash
sudo systemctl restart yenwatch
sudo systemctl status yenwatch
journalctl -u yenwatch -n 30
```

</details>

---

## 17. 데이터 백업

### 17.1 온라인 백업 (권장)

서비스를 멈추지 않고 안전한 스냅샷을 만듭니다. SQLite Online Backup API를 사용하므로 WAL 모드에서도 일관성이 보장됩니다.

```bash
cd /opt/yenwatch
npm run backup                              # data/backups/ 에 저장, 최근 14개 유지
npm run backup -- --out /mnt/usb/yenwatch   # 위치 지정
npm run backup -- --keep 30                 # 30개 유지
```

또는 셸 스크립트:

```bash
/opt/yenwatch/deploy/backup.sh
/opt/yenwatch/deploy/backup.sh /mnt/usb/yenwatch
```

### 17.2 자동 백업 (cron)

```bash
crontab -e
```

```cron
# 매일 새벽 3시 백업
0 3 * * * /opt/yenwatch/deploy/backup.sh >> /var/log/yenwatch-backup.log 2>&1
```

### 17.3 오프라인 백업

확실하게 하고 싶다면 서비스를 멈추고 복사합니다.

```bash
npm run pm2:stop
cp /opt/yenwatch/data/yenwatch.db \
   /opt/yenwatch/data/yenwatch-$(date +%Y%m%d-%H%M%S).db
npm run pm2:restart
```

> ⚠️ 서비스가 **실행 중일 때** `cp`로 `.db` 파일만 복사하면 WAL에 남은 데이터가 빠질 수 있습니다. 온라인 백업(17.1)을 쓰거나 서비스를 멈추세요.

### 17.4 복원

```bash
npm run pm2:stop

cd /opt/yenwatch/data
mv yenwatch.db yenwatch.db.broken
cp backups/yenwatch-20260729-030000.db yenwatch.db
rm -f yenwatch.db-wal yenwatch.db-shm     # 이전 WAL 잔재 제거

sqlite3 yenwatch.db 'PRAGMA integrity_check;'   # ok 확인
npm run pm2:restart
```

### 17.5 백업에 포함할 것

| 파일                     | 백업 필요 | 비고                                                  |
| ------------------------ | --------- | ----------------------------------------------------- |
| `data/yenwatch.db`       | ✅        | 환율 이력, 메시지 ID, 헬스 이벤트                     |
| `.env`                   | ✅        | **안전한 곳에 별도 보관.** Git에는 절대 올리지 마세요 |
| `node_modules/`, `dist/` | ❌        | `npm ci && npm run build`로 재생성                    |

---

## 18. 장애 해결

### 봇이 오프라인입니다

```bash
pm2 status                            # online 인지, ↺ 재시작 횟수가 늘고 있는지
pm2 logs yenwatch --err --lines 50
```

| 증상 / 로그 메시지                       | 원인                                    | 해결                                                      |
| ---------------------------------------- | --------------------------------------- | --------------------------------------------------------- |
| `pm2 status` 목록이 비어 있음            | `pm2 save` 를 안 했거나 데몬이 초기화됨 | `pm2 resurrect` → 안 되면 `npm run pm2:start && pm2 save` |
| `status: errored`, ↺ 가 계속 증가        | 앱이 시작 직후 죽는 중                  | `pm2 logs yenwatch --err` 로 원인 확인                    |
| `status: stopped`                        | 수동으로 멈춘 상태                      | `npm run pm2:restart`                                     |
| `환경변수 검증에 실패했습니다`           | `.env` 값 누락/오류                     | `npm run cli -- check` 로 확인                            |
| `An invalid token was provided`          | 토큰이 틀림                             | Developer Portal에서 Reset Token 후 `.env` 갱신           |
| `Cannot find module '.../dist/index.js'` | 빌드를 안 함                            | `npm run build && npm run pm2:restart`                    |
| `Permission denied` on data              | 디렉터리 소유권                         | `sudo chown -R $USER:$USER /opt/yenwatch/data`            |
| `.env` 를 고쳤는데 반영 안 됨            | pm2 가 이전 환경변수를 유지             | `npm run pm2:restart` (`--update-env` 포함)               |

<details>
<summary>systemd 를 쓴다면</summary>

```bash
sudo systemctl status yenwatch
journalctl -u yenwatch -n 50
```

| 로그 메시지       | 원인             | 해결                                 |
| ----------------- | ---------------- | ------------------------------------ |
| `status=203/EXEC` | node 경로가 틀림 | `which node` 결과로 `ExecStart` 수정 |
| `status=217/USER` | 사용자가 없음    | `User=` 를 `whoami` 결과로 수정      |

</details>

### 상태 메시지가 안 보입니다

1. 채널 ID가 맞는지 확인 — 채널 우클릭 → 채널 ID 복사
2. 봇 권한 확인 — 채널 편집 → 권한 → YenWatch에 **채널 보기 / 메시지 보내기 / 링크 첨부 / 메시지 기록 보기**
3. 통합 점검

   ```bash
   npm run check
   ```

4. 메시지를 실수로 지웠다면 — 다음 수집(1분 이내)에 자동으로 새로 만듭니다. 즉시 원하면 `npm run pm2:restart`

### 슬래시 커맨드가 안 뜹니다

```bash
npm run discord:register
```

그래도 안 되면:

- 초대 URL에 `applications.commands` scope가 있었는지 확인 → 없었다면 6장의 URL로 다시 초대
- `DISCORD_GUILD_ID`가 맞는지 확인
- Discord 앱을 완전히 껐다 켜기 (`Ctrl+R`로 새로고침)

### `/yen-refresh` 가 "권한이 없습니다"

`.env`의 `DISCORD_ALLOWED_USER_IDS`에 본인 ID가 있어야 합니다.

```bash
npm run cli -- set DISCORD_ALLOWED_USER_IDS 123456789012345678
npm run pm2:restart
```

여러 명이면 쉼표로 구분합니다: `111...,222...`

### 환율 수집이 계속 실패합니다

```bash
npm run cli -- scrape     # 네트워크 + 파서만 단독 테스트
```

| 증상                                      | 원인                        | 해결                                     |
| ----------------------------------------- | --------------------------- | ---------------------------------------- |
| `요청이 10000ms 안에 완료되지 않았습니다` | 네트워크 느림/끊김          | `REQUEST_TIMEOUT_MS=20000` 으로 늘리기   |
| `HTTP 429`                                | 요청이 너무 잦음            | `SCRAPE_INTERVAL_SECONDS`를 120 이상으로 |
| `HTTP 5xx`                                | 네이버 점검                 | 잠시 기다리면 자동 복구됩니다            |
| `환율 파싱 실패 — 시도한 파서: ...`       | **네이버 페이지 구조 변경** | 아래 참고                                |
| `허용 범위를 벗어났습니다`                | 파싱은 됐지만 값이 이상함   | 범위 설정 확인, 또는 파서 문제           |

**페이지 구조가 바뀐 경우**

로그에 어떤 파서가 왜 실패했는지 전부 남습니다.

```bash
jq -c 'select(.event == "rate_parse_failed")' /opt/yenwatch/logs/yenwatch-out.log
```

```json
{
  "event": "rate_parse_failed",
  "httpStatus": 200,
  "contentType": "text/html;charset=EUC-KR",
  "contentLength": 64609,
  "charset": "euc-kr",
  "attempts": "no_today_text=값을 찾지 못함, no_today_digit_classes=값을 찾지 못함, ..."
}
```

`src/scraper/parsers.ts`에 파서를 추가하고 `tests/fixtures/`에 새 HTML을 넣어 테스트를 작성하세요. 6개 파서가 **모두** 실패해야 수집이 실패하므로, 보통은 하나가 깨져도 서비스는 계속 동작합니다.

### Notion에 아무것도 안 올라갑니다

```bash
npm run notion:check
```

| 오류                            | 원인                                         | 해결                          |
| ------------------------------- | -------------------------------------------- | ----------------------------- |
| `object_not_found`              | data source ID가 틀리거나 integration 미연결 | 9.2 / 9.3 다시 확인           |
| `unauthorized`                  | 토큰이 틀림                                  | 8장에서 Secret 재복사         |
| `누락된 속성: "Change Percent"` | 속성명 불일치                                | 출력된 그대로 Notion에서 수정 |
| `타입이 잘못된 속성`            | 예: Rate가 Text로 되어 있음                  | Number로 변경                 |

> Notion이 실패해도 **Discord와 SQLite는 정상 동작합니다.** 급하지 않다면 `NOTION_ENABLED=false`로 잠시 꺼두고 나중에 고쳐도 됩니다.

### SQLite 오류

```bash
sqlite3 /opt/yenwatch/data/yenwatch.db 'PRAGMA integrity_check;'
```

`ok`가 아니면 백업에서 복원하세요 (17.4).

`database is locked`가 반복되면 프로세스가 중복 실행 중일 수 있습니다.

```bash
ps aux | grep '[y]enwatch\|[d]ist/index.js'
npm run pm2:restart
```

### 디스크가 가득 찼습니다

```bash
df -h
du -sh /opt/yenwatch/data/*

npm run cli -- retention              # 오래된 데이터 즉시 정리
pm2 flush yenwatch                    # 로그 정리
```

보존 기간을 줄이려면:

```bash
npm run cli -- set DATA_RETENTION_DAYS 90
npm run pm2:restart
```

> 참고: 1분 간격으로 1년이면 약 52만 행, 대략 30–50MB 수준입니다.

### 시간이 이상하게 표시됩니다

```bash
timedatectl                       # Time zone: Asia/Seoul (KST, +0900)
sudo timedatectl set-timezone Asia/Seoul
npm run pm2:restart
```

저장은 항상 UTC(ISO 8601)이고 표시만 Asia/Seoul로 변환하므로, 시간대를 바꿔도 기존 데이터는 안전합니다.

---

## 19. 보안 주의사항

### 절대 하지 말아야 할 것

- ❌ `.env`를 Git에 커밋 (`.gitignore`에 이미 포함되어 있습니다)
- ❌ 토큰을 Discord·블로그·이슈에 붙여넣기
- ❌ 봇에 Administrator 권한 부여
- ❌ Notion integration을 워크스페이스 전체에 연결

### 반드시 해야 할 것

**① `.env` 권한을 600으로**

```bash
chmod 600 /opt/yenwatch/.env
ls -l /opt/yenwatch/.env       # -rw------- 확인
```

소유자만 읽고 쓸 수 있습니다. `npm run cli`의 3번 메뉴로도 설정할 수 있습니다.

**② 최소 권한 원칙**

- Discord: 5개 권한만 (View Channels / Send Messages / Embed Links / Read Message History / Use Application Commands)
- Discord Intents: 특권 Intent 전부 끔
- Notion: 필요한 데이터베이스에만 integration 연결

**③ 토큰이 노출됐다면 즉시**

- Discord: Developer Portal → Bot → **Reset Token**
- Notion: my-integrations → **Rotate secret**
- `.env` 갱신 후 `npm run pm2:restart`

### 코드에서 지키는 것

- 모든 비밀값은 `.env`에서만 읽습니다. 코드에 하드코딩된 값이 없습니다.
- Pino `redact` 설정으로 `token` / `DISCORD_TOKEN` / `NOTION_TOKEN` / `authorization` 필드를 강제 마스킹합니다.
- 환경변수 검증 오류 메시지에 **값이 아니라 키 이름만** 출력합니다.
- 파싱 실패 로그에 **HTML 본문을 절대 남기지 않습니다.** (상태 코드, Content-Type, 길이, 인코딩, 시도한 파서만)
- CLI에서 값을 보여줄 때 토큰류는 앞 4자만 노출합니다.
- 모든 HTTP 요청에 타임아웃이 있습니다.
- systemd 유닛에 `NoNewPrivileges` / `ProtectSystem=full` / `ProtectHome=read-only` / `ReadWritePaths` 적용.

### git-secrets로 실수 방지 (선택)

```bash
sudo apt install -y git-secrets
cd /opt/yenwatch
git secrets --install
git secrets --add 'MT[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,}'
git secrets --add '(ntn|secret)_[A-Za-z0-9]{40,}'
```

---

## 20. 라이선스

MIT License — 자세한 내용은 [LICENSE](./LICENSE)를 참고하세요.

### 데이터 출처

환율 데이터는 [네이버 금융](https://finance.naver.com/marketindex/)에서 가져옵니다. 이 프로젝트는 네이버와 아무 관련이 없으며, **개인적인 참고 용도**로만 사용하세요.

- 상업적 이용이나 재배포 전에는 네이버 이용약관을 확인하세요.
- 기본 수집 주기(60초)보다 짧게 설정하지 마세요. 서버에 부담을 주고 차단될 수 있습니다.
- 투자 판단의 근거로 삼지 마세요. 실제 환전 시에는 은행 고시 환율을 확인하세요.

---

<div align="center">

**문제가 생겼나요?** → [18. 장애 해결](#18-장애-해결) · `npm run check` · `pm2 logs yenwatch`

</div>
