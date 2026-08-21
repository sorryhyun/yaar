# YAAR

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React_19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Bun](https://img.shields.io/badge/Bun_≥1.3-F9F1E1?logo=bun&logoColor=black)](https://bun.sh/)
[![MCP](https://img.shields.io/badge/MCP-F26922?logo=anthropic&logoColor=white)](https://modelcontextprotocol.io/)
[![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-D97757?logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/agents-and-tools/claude-agent-sdk)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

[English](./README.md)

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
VERSION=v0.17.0 curl -fsSL ... | bash    # 특정 버전 (기본: 최신)
INSTALL_DIR=/usr/local/bin curl -fsSL ... | bash  # 설치 경로 (기본: ~/.local/bin)
```

**Windows:** `yaar.exe`를 [릴리즈 페이지](https://github.com/sorryhyun/yaar/releases)에서 직접 다운로드할 수도 있습니다.

번들 앱은 바이너리와 별도로 `yaar-apps.tar.gz`로 배포되며, 설치 스크립트가 바이너리 옆에 자동으로 풀어줍니다.

**소스에서 빌드** ([Bun](https://bun.sh/) >= 1.4 필요):
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

텍스트 입력창만이 아니라 데스크톱 전체가 입력 수단입니다:

| 입력 방식 | 동작 |
|-----------|------|
| 타이핑 | 메시지 전송 |
| 이미지 붙여넣기 / 드래그 앤 드롭 | AI에게 이미지 전달 |
| 우클릭 드래그 | 그림을 그려서 AI에게 전달 |
| 버튼 클릭 | 윈도우 내 액션 실행 |
| 우클릭 → 윈도우 선택 | 특정 윈도우에 지시사항 전송 |
| 파일/영역을 앱으로 드래그 | 앱 간 데이터 전달 |


## 뭐가 다른가요?

- **단 5개의 도구로 모든 것을 합니다.** 윈도우, 파일, 앱, 설정 — 모든 리소스가 `yaar://` URI이고, 5개의 범용 verb로 조작합니다. 에이전트가 `describe`로 기능을 런타임에 발견하므로, 앱을 100개 설치해도 시스템 프롬프트는 8K 토큰 이하로 유지됩니다.

  ```
  describe · read · list · invoke · delete

  invoke('yaar://windows/chart', { ... })    read('yaar://storage/data.csv')
  list('yaar://apps')                        delete('yaar://windows/old-panel')
  ```

- **폴더 하나 = 앱 하나.** 스킬, 플러그인, 에이전트, UI가 하나의 폴더 규약으로 통일됩니다: 메타데이터(`app.json`, 그 `description`이 AI가 읽는 설명을 겸함), 전용 에이전트 프롬프트(`agent/prompt.md`, 선택), 그리고 단일 HTML 파일로 빌드되는 소스. 폴더를 넣으면 설치, 지우면 제거 — 등록 코드가 없습니다.

- **앱마다 자기 에이전트를 가집니다.** `agent/prompt.md`를 넣으면 그 앱 전용 에이전트가 생기고, 모니터 에이전트와 서로 메시지를 주고받습니다. 앱이 다른 앱을 직접 조종할 수도 있습니다 (`app.json`의 `controls`) — 예를 들어 Dev Tools는 실제 브라우저 앱을 몰아 앱을 만들고 테스트까지 끝냅니다.

- **권한이 명시적이고 범위가 한정적입니다.** 앱은 `app.json`에 선언한 `permissions`와 자기 스토리지로 한정됩니다. 외부 HTTP는 도메인 허용 목록에 등록된 곳만 가능하고, 신규 도메인은 사용자 승인이 필요하며, 모든 승인/거부 결정이 기록됩니다. 자세한 내용은 [보안](#보안) 섹션 참고.

- **AI가 UI를 직접 생성합니다.** 텍스트 응답 대신 윈도우를 띄우고, 알림을 표시하고, 앱을 조작하는 방식으로 반응합니다 — 응답은 캐싱되어 윈도우를 다시 렌더링할 때 AI에게 재질의하지 않습니다.

- **UI가 데이터를 따라 살아 움직입니다.** 앱은 `yaar://` URI를 구독해두면 그 리소스가 바뀔 때 서버가 밀어줍니다. 폴링 없이, 다시 물어볼 필요 없이 화면이 갱신됩니다.

왜 이렇게 만들었는지 — 왜 TUI가 아니라 GUI인지, 왜 OS 형태인지, 왜 웹인지 — 궁금하다면 [FAQ](./docs/faq.md)를 참고하세요.


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
- **앱 권한 범위** — 앱은 `app.json`의 `permissions`와 자동으로 부여되는 자기 네임스페이스(`yaar://apps/self/…` — 스토리지, 데이터베이스, 페르소나)로 한정됩니다.
- **게이트된 SDK 도어** — `yaar-dev` / `yaar-web` / `yaar-ml` 전용 엔드포인트는 서버에서 재확인합니다. 컴파일 타임 게이트만으로는 손으로 쓴 `fetch()`를 막지 못하기 때문입니다.
- **에이전트 티어** — `yaar://session/*`(사용자의 실제 Chrome을 조작하는 문 포함)은 세션 에이전트만 접근 가능하며, 나머지는 기본 거부됩니다.
- **도메인 허용 목록 + SSRF 방어** — `config/curl_allowed_domains.yaml`에 등록된 도메인만 허용, 신규 도메인은 사용자 승인 필요. 내부망 주소로의 우회 요청도 차단합니다.
- **MCP 인증** — 전송 계층은 공유 Bearer 토큰으로, 호출 주체 식별은 에이전트별로 발급·바인딩되는 별도 토큰(`X-Agent-Token`)으로 처리합니다.
- **권한 기억** — 승인/거부 결정을 `config/permissions.json`에 저장
- **경로 검증** — path traversal 방지

- **앱 오리진 격리** (모든 모드에서 기본 활성화) — 설치된 앱은 데스크톱과 다른 브라우저 오리진에서 제공되어, 앱이 토큰을 생략하고 데스크톱 행세를 할 수 없고, 브라우저가 `window.parent`로 데스크톱의 DOM·JS 메모리에 접근하는 것도 막습니다. 로컬에서는 데스크톱이 `localhost`, 앱이 `127.0.0.1`이고, 네트워크 너머에서는 Tailscale Serve가 같은 짝을 `…ts.net` / `…ts.net:8443`으로 게시합니다. `YAAR_APP_ORIGIN_ISOLATION=0`으로 끌 수 있습니다.


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
