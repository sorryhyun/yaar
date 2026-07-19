# YAAR

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React_19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Bun](https://img.shields.io/badge/Bun_≥1.3-F9F1E1?logo=bun&logoColor=black)](https://bun.sh/)
[![MCP](https://img.shields.io/badge/MCP-F26922?logo=anthropic&logoColor=white)](https://modelcontextprotocol.io/)
[![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-D97757?logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/agents-and-tools/claude-agent-sdk)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

[English version](./README.en.md)

> **Y**ou **A**re **A**bsolutely **R**ight — AI가 다음에 무엇을 보여주고 할지 스스로 결정하는 리액티브 AI 인터페이스.


![YAAR Desktop](./docs/assets/image.png)

MCP 도구, 스킬, 플러그인, A2A까지 — 시스템 프롬프트 8K 토큰 안에서 전부 동작합니다. 앱을 만들고, 데이터를 시각화하고, 외부 서비스와 연동합니다.


## 설치

Codex 혹은 Claude Code 사용자 인증이 필수입니다.

```bash
curl -fsSL https://github.com/sorryhyun/yaar/releases/latest/download/install.sh | bash
yaar                # 브라우저가 자동으로 열립니다
```

Linux, macOS (Intel & Apple Silicon), Windows (WSL) 지원. 바이너리 하나로 실행되며, Bun이나 Node.js 설치가 필요 없습니다.

Windows (PowerShell): `irm https://github.com/sorryhyun/yaar/releases/latest/download/install.ps1 | iex`

실행 후 "필수 앱 설치해줘" 같은 말로 시작하시면 됩니다.

<details>
<summary>기타 설치 옵션</summary>

**특정 버전 / 설치 경로 변경:**
```bash
VERSION=v0.1.0 curl -fsSL ... | bash     # 특정 버전 (기본: 최신)
INSTALL_DIR=/usr/local/bin curl -fsSL ... | bash  # 설치 경로 (기본: ~/.local/bin)
```

**Windows:** `yaar.exe`를 [릴리즈 페이지](https://github.com/sorryhyun/yaar/releases)에서 직접 다운로드할 수도 있습니다.

번들 앱은 바이너리와 별도로 `yaar-apps.tar.gz`로 배포되며, 설치 스크립트가 바이너리 옆에 자동으로 풀어줍니다.

**소스에서 빌드** ([Bun](https://bun.sh/) >= 1.3 필요):
```bash
git clone https://github.com/sorryhyun/yaar.git && cd yaar
bun install
make dev          # 브라우저가 자동으로 열립니다
```

</details>


## 이런 걸 할 수 있습니다

- **"이 CSV 분석해줘"** → AI가 데이터를 읽고 차트 윈도우를 띄웁니다
- **"발표자료 만들어줘"** → Slides Lite가 슬라이드 덱을 생성합니다
- **우클릭 드래그로 스케치** → AI가 그림을 해석해 코드나 다이어그램으로 변환합니다
- **"테트리스 만들어줘"** → AI가 코드를 작성·빌드하고, 바로 플레이 가능한 앱으로 배포합니다


## 뭐가 다른가요?

- **단 5개의 도구로 모든 것을 합니다.** tool description을 에이전트가 스스로 찾게 하여 초기 컨텍스트를 최소화하고, I/O와 function을 'verb'라는 핸들러로 단일화했습니다.

    <details>
    <summary>기존 방식과 비교</summary>

    기존 MCP 서버는 기능마다 별도의 tool을 등록합니다. 앱이나 기능이 추가될수록 tool 수가 늘어나고, 시스템 프롬프트가 비대해집니다.

    ```
    ❌ 기존: tool 수가 기능에 비례하여 증가
    ┌──────────────────────────────────────┐
    │ read_file, write_file, delete_file,  │
    │ list_directory, create_window,       │
    │ update_window, close_window,         │
    │ get_app_info, install_app,           │
    │ send_notification, run_code,         │
    │ fetch_url, manage_config, ...        │
    │                                      │
    │ → tool 20개+ (앱 추가 시 계속 증가)  │
    │ → 시스템 프롬프트 30K+ 토큰          │
    └──────────────────────────────────────┘

    ✅ YAAR: 모든 리소스를 URI로 통일, 5개 verb로 접근
    ┌──────────────────────────────────────┐
    │ describe · read · list · invoke · delete │
    │                                      │
    │ describe('yaar://apps/slides-lite')  │
    │ → 지원 verb, 스키마, 설명 반환       │
    │                                      │
    │ invoke('yaar://windows/main', {...}) │
    │ read('yaar://storage/data.csv')      │
    │ list('yaar://apps')                  │
    │ delete('yaar://windows/old-panel')   │
    │                                      │
    │ → 앱 100개를 설치해도 tool은 5개     │
    │ → 시스템 프롬프트 8K 토큰 이하 유지  │
    └──────────────────────────────────────┘
    ```

    </details>

- **AGENTS.md, skill, plugin, UI를 모두 통일한 구조 'app'을 사용합니다.** 폴더 하나가 곧 앱이고, 설치도 삭제도 폴더 단위입니다.

    <details>
    <summary>기존 방식과 비교</summary>

    기존 AI 도구에서는 agent, skill, plugin, custom UI가 각각 다른 형식과 등록 방식을 가집니다. YAAR에서는 하나의 폴더 구조가 이 모든 것을 통일합니다.

    ```
    ❌ 기존: 역할마다 다른 형식, 다른 등록 방식
    ┌──────────────────────────────────────┐
    │ skills/                              │
    │   slide-maker.yaml    ← AI 능력     │
    │ plugins/                             │
    │   slide-export.js     ← 서버 확장   │
    │ ui-components/                       │
    │   slide-viewer.tsx    ← 프론트엔드  │
    │ configs/                             │
    │   slide-settings.json ← 설정        │
    │                                      │
    │ → 4곳에 분산, 각각 등록 코드 필요    │
    └──────────────────────────────────────┘

    ✅ YAAR: 폴더 하나 = 앱 하나
    ┌──────────────────────────────────────┐
    │ apps/slides-lite/                    │
    │   app.json         ← 메타데이터     │
    │   SKILL.md         ← AI가 읽는 설명 │
    │   AGENTS.md        ← 앱 에이전트 정의│
    │   src/main.ts      ← UI + 로직      │
    │   dist/                              │
    │     index.html     ← 빌드 결과물    │
    │     protocol.json  ← 상태/명령 스키마│
    │                                      │
    │ → 폴더 넣으면 설치, 삭제하면 제거    │
    │ → 등록 코드 zero, 빌드는 단일 HTML   │
    └──────────────────────────────────────┘
    ```

    </details>

- **앱마다 자기 에이전트를 가집니다.** `AGENTS.md`를 넣으면 그 앱 전용 에이전트가 생기고, 모니터 에이전트와 서로 메시지를 주고받습니다. 앱이 다른 앱을 직접 조종할 수도 있습니다 (`app.json`의 `controls`) — 예를 들어 Dev Tools는 실제 브라우저 앱을 몰아 앱을 만들고 테스트까지 끝냅니다.

- **권한 영역을 명시적으로 분리합니다.** 앱의 접근 범위, 파일시스템, 네트워크가 가시화되며 사용자가 제어합니다.

    <details>
    <summary>기존 방식과 비교</summary>

    기존 AI 도구는 한번 권한을 부여하면 모든 파일과 네트워크에 접근 가능합니다. YAAR은 앱별 스토리지 격리, 도메인 허용 목록, 사용자 승인 흐름을 분리합니다.

    ```
    ❌ 기존: 권한이 암묵적이고 전역적
    ┌──────────────────────────────────────┐
    │ AI에게 파일 접근 권한 부여           │
    │ → 시스템 전체 파일시스템 접근 가능   │
    │ → 어떤 파일에 접근했는지 불투명      │
    │ → 네트워크 요청도 제한 없음          │
    └──────────────────────────────────────┘

    ✅ YAAR: 권한이 명시적이고 범위가 한정적
    ┌──────────────────────────────────────┐
    │ app.json                             │
    │ { "permissions": [                   │
    │     "yaar://apps/self/storage/"      │
    │   ] }                                │
    │ → 앱은 자기 스토리지만 접근 가능     │
    │                                      │
    │ config/curl_allowed_domains.yaml     │
    │ allowed_domains:                     │
    │   - github.com                       │
    │   - api.example.com                  │
    │ → 등록된 도메인만 요청 허용          │
    │ → 신규 도메인은 사용자에게 승인 요청 │
    │                                      │
    │ config/permissions.json              │
    │ → 모든 승인/거부 이력이 기록됨       │
    └──────────────────────────────────────┘
    ```

    </details>

- **AI가 UI를 직접 생성합니다.** 텍스트 응답 대신 윈도우를 띄우고, 알림을 표시하고, 앱을 조작하는 방식으로 반응합니다.

    <details>
    <summary>기존 방식과 비교</summary>

    기존 AI 도구는 텍스트(또는 마크다운)로 응답합니다. UI가 필요하면 별도로 프론트엔드를 만들어야 합니다.

    ```
    ❌ 기존: 텍스트 기반 응답
    ┌──────────────────────────────────────┐
    │ User: "이 CSV 분석해줘"              │
    │ AI: "분석 결과입니다:\n- 평균: 42..."│
    │                                      │
    │ → 차트가 필요하면? 별도 코드 실행    │
    │ → 인터랙션? 불가능                   │
    └──────────────────────────────────────┘

    ✅ YAAR: AI가 UI로 직접 응답
    ┌──────────────────────────────────────┐
    │ User: "이 CSV 분석해줘"              │
    │ AI: invoke('yaar://windows/chart',   │
    │       { renderer: "iframe", ... })   │
    │                                      │
    │ → 차트 윈도우가 열림                 │
    │ → 버튼 클릭, 드래그 등 인터랙션 가능 │
    │ → 응답 캐싱으로 즉시 재사용          │
    └──────────────────────────────────────┘
    ```

    | 입력 방식 | 동작 |
    |-----------|------|
    | 타이핑 | 메시지 전송 |
    | 이미지 붙여넣기 / 드래그 앤 드롭 | AI에게 이미지 전달 |
    | 우클릭 드래그 | 그림을 그려서 AI에게 전달 |
    | 버튼 클릭 | 윈도우 내 액션 실행 |
    | 우클릭 → 윈도우 선택 | 특정 윈도우에 지시사항 전송 |
    | 파일/영역을 앱으로 드래그 | 앱 간 데이터 전달 |

    </details>

- **UI가 데이터를 따라 살아 움직입니다.** 앱은 `yaar://` URI를 구독해두면 그 리소스가 바뀔 때 서버가 밀어줍니다. 폴링 없이, 다시 물어볼 필요 없이 화면이 갱신됩니다.


## 기본 구조

```
브라우저 (UI) ←→ 로컬 서버 ←→ Claude Code / Codex (AI)
```

실행 시 자동으로 `storage/, config/, apps/, session_logs/` 폴더를 생성하며, AI의 파일 접근은 기본적으로 이 폴더들로 한정됩니다. 외부 폴더를 연결하려면 Storage 앱의 "Mount..." 버튼으로 마운트하세요 — 별칭과 경로를 지정하면 `storage/mounts/{별칭}/`으로 접근 가능하며, 읽기 전용 옵션도 지원합니다.


## 주요 기능

### 앱 생태계

앱은 YAAR Market에서 둘러보고 바로 설치할 수 있습니다 — 파일 매니저, 스프레드시트, 문서/슬라이드 편집기, PDF·이미지·영상 뷰어, RSS 리더, GitHub 관리, 브라우저, 인앱 IDE(Dev Tools), 프로세스 탐색기, MCP 매니저 등이 기본 제공됩니다. 목록은 계속 늘어나므로 여기 옮겨 적는 대신 Market에서 확인하세요.

직접 앱을 개발할 수도 있습니다:

- **번들 라이브러리** — Solid.js, lodash, Three.js, Konva, Chart.js, D3, Tone.js 등을 `npm install` 없이 `@bundled/*`로 바로 import
- **단일 HTML 번들** — 빌드 결과물이 HTML 파일 하나라 어디서든 독립 실행 가능
- **`appDb`** — 앱마다 격리된 SQLite. Mongo 스타일 필터와 FTS5 전문 검색 지원 ([가이드](./docs/guides/sqlite.md))
- **게이트된 SDK** — `app.json`에 선언해야 열리는 확장 권한: `yaar-dev`(컴파일·배포), `yaar-web`(브라우저 자동화), `yaar-ml`(브라우저 내 ONNX 추론)
- **배포 되돌리기** — 앱마다 shadow git 저장소가 있어 배포 전후로 스냅샷이 남고, 언제든 이전 버전으로 복구 가능

자세한 내용은 [앱 개발 가이드](./docs/guides/app-development.md)를 참고하세요.


### 멀티 모니터 & 세션

여러 **가상 데스크톱(모니터)** 을 만들어 작업을 분리할 수 있습니다. 각 모니터는 독립된 모니터 에이전트와 대화 히스토리를 가집니다. 그 위에는 모니터를 가로질러 상황을 파악하는 **세션 에이전트**가 있습니다. 세션은 브라우저를 닫아도 유지되며, `?sessionId=X`로 다른 탭/기기에서 같은 세션에 접속할 수 있습니다.


### 원격 접속

`make claude` 또는 `make codex`로 실행하면 원격 모드가 자동 활성화됩니다. 터미널에 QR 코드가 표시되며, 핸드폰으로 스캔하면 토큰 인증까지 자동으로 처리되어 바로 접속됩니다. SSH 터널링을 통해 외부 네트워크에서도 사용 가능합니다. 자세한 내용은 [원격 접속 가이드](./docs/guides/remote_mode.md)를 참고하세요.


### Hooks

`config/hooks.json`으로 이벤트 기반 자동화를 설정할 수 있습니다. 특정 이벤트 발생 시 자동으로 액션을 실행합니다. 자세한 내용은 [Hooks 가이드](./docs/guides/hooks.md)를 참고하세요.


## 보안

AI가 코드를 실행하고 외부 서비스와 통신하는 만큼, 여러 보안 레이어를 갖추고 있습니다.

- **단일 접근 관문** — 모든 HTTP 라우트가 호출자를 principal(데스크톱 `host` / 앱 `app`)로 판별하고, 수행하려는 `yaar://` URI와 verb를 명시해 같은 검사를 통과합니다. 라우트가 제각각 권한 검사를 발명하지 않습니다.
- **앱 권한 범위** — 앱은 `app.json`의 `permissions`와 자기 스토리지(`yaar://apps/self/storage/`)로 한정됩니다.
- **게이트된 SDK 도어** — `yaar-dev` / `yaar-web` / `yaar-ml` 전용 엔드포인트는 서버에서 재확인합니다. 컴파일 타임 게이트만으로는 손으로 쓴 `fetch()`를 막지 못하기 때문입니다.
- **에이전트 티어** — `yaar://session/*`(사용자의 실제 Chrome을 조작하는 문 포함)은 세션 에이전트만 접근 가능하며, 나머지는 기본 거부됩니다.
- **도메인 허용 목록 + SSRF 방어** — `config/curl_allowed_domains.yaml`에 등록된 도메인만 허용, 신규 도메인은 사용자 승인 필요. 내부망 주소로의 우회 요청도 차단합니다.
- **MCP 인증** — 전송 계층은 공유 Bearer 토큰으로, 호출 주체 식별은 에이전트별로 발급·바인딩되는 별도 토큰(`X-Agent-Token`)으로 처리합니다.
- **권한 기억** — 승인/거부 결정을 `config/permissions.json`에 저장
- **경로 검증** — path traversal 방지

**알려진 한계:** 로컬 앱 iframe은 same-origin으로, 샌드박스 없이 실행됩니다. 즉 위 모델은 네트워크 호출자와 세션·앱 간 접근, 그리고 규칙을 지키는 앱의 실수는 막지만, **의도적으로 탈출하려는 악성 앱 코드는 막지 못합니다.** 신뢰할 수 없는 앱은 설치하지 마세요. 자세한 내용과 해결 방향은 [known gaps](./docs/architecture/known_gaps.md)를 참고하세요.


## 프로젝트 구조

```
yaar/
├── apps/              # 여기에 폴더를 넣으면 앱이 됩니다
├── config/            # 사용자 설정 및 자격 증명 (git-ignored)
├── storage/           # AI가 접근하는 파일 저장소 (git-ignored)
├── packages/
│   ├── shared/        # OS Actions, WebSocket 이벤트, Component DSL 타입
│   ├── compiler/      # 앱 컴파일러 (@bundled/* 해석, 단일 HTML 번들)
│   ├── server/        # WebSocket 서버 + AI 프로바이더 (Claude/Codex)
│   ├── frontend/      # React 프론트엔드
│   └── tests/         # 통합 및 보안 테스트
```

YAAR의 구조는 전통적인 OS 아키텍처로도 해석될 수 있습니다. `LiveSession`은 커널, 에이전트는 프로세스, MCP 도구는 시스템 콜, `storage/`는 파일시스템에 대응됩니다. 자세한 매핑은 [OS Architecture Map](./docs/architecture/os_architecture.md)을 참고하세요.

개발 관련 상세 내용은 [CLAUDE.md](./CLAUDE.md)를 참고하세요.
