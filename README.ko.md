# YAAR

**고쳐 쓰고, 간직하고, 나누는 소프트웨어 — 어떤 에이전트든 다룰 수 있는 모양으로.**

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React_19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Bun](https://img.shields.io/badge/Bun_≥1.3-F9F1E1?logo=bun&logoColor=black)](https://bun.sh/)
[![MCP](https://img.shields.io/badge/MCP-F26922?logo=anthropic&logoColor=white)](https://modelcontextprotocol.io/)
[![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-D97757?logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/agents-and-tools/claude-agent-sdk)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

[English](./README.md)

![YAAR Desktop](./docs/assets/image.png)

YAAR는 로컬 데스크톱입니다. 이미 쓰고 있는 에이전트 — Claude Code 또는 Codex — 가 앱을
만들고, 당신은 지금 보고 있는 앱에게 말을 걸어 그 앱을 바꿉니다. 모든 앱은 디스크 위의 폴더
하나이고, 자기만의 git 히스토리를 가집니다. 호스팅되는 것도, 빌려 쓰는 것도 없습니다.

```
"테트리스 게임 만들어줘"                   → 작성하고, 빌드하고, 창을 엽니다
"블록 떨어지는 속도 더 빠르게"              → 실행 중인 앱을 그 자리에서 수정하고 다시 배포합니다
"방금 거 되돌려줘"                         → 직전 배포로 롤백합니다
"이거 올려줘"                              → 소스를 YAAR Market에 게시합니다
```

채팅 어시스턴트는 매번 새로 생성하고, 앱스토어는 다시 빌드해서 다시 제출하게 합니다. YAAR는
그 사이에 있습니다: 지금 쓰고 있는 앱이 곧 고쳐 쓸 수 있는 앱이고, 고치는 것도 그 앱을 만든
에이전트입니다.

## 설치

Codex 또는 Claude Code 인증이 필요합니다.

```bash
curl -fsSL https://github.com/sorryhyun/yaar/releases/latest/download/install.sh | bash
yaar                # 브라우저가 자동으로 열립니다
```

Linux, macOS (Intel & Apple Silicon), Windows (WSL)를 지원합니다. 단일 바이너리 — Bun이나 Node.js가 필요 없습니다.

Windows (PowerShell): `irm https://github.com/sorryhyun/yaar/releases/latest/download/install.ps1 | iex`

실행되면 "필수 앱 설치해줘" 같은 말로 시작해 보세요.

<details>
<summary>다른 설치 방법</summary>

**버전 고정 / 설치 경로 지정:**

```bash
VERSION=v0.18.0 curl -fsSL ... | bash             # 특정 버전 (기본: latest)
INSTALL_DIR=/usr/local/bin curl -fsSL ... | bash  # 설치 경로 (기본: ~/.local/bin)
```

**Windows:** [Releases 페이지](https://github.com/sorryhyun/yaar/releases)에서 `yaar.exe`를 직접 받을 수도 있습니다.

번들 앱은 `yaar-apps.tar.gz`로 따로 배포되며, 설치 스크립트가 바이너리 옆에 자동으로 풀어 둡니다.

**소스에서 빌드** ([Bun](https://bun.sh/) >= 1.4 필요):

```bash
git clone https://github.com/sorryhyun/yaar.git && cd yaar
bun install
make dev          # 브라우저가 자동으로 열립니다
```

</details>

## 왜 YAAR인가

- **앱은 당신의 것입니다.** 폴더 하나 = 앱 하나: `app.json`, 소스, 선택적인 에이전트
  프롬프트가 자체 완결된 HTML 파일 하나로 컴파일됩니다. 넣으면 설치, 지우면 삭제, 원하는
  곳에 `git`으로 올리면 됩니다. 배포할 때마다 섀도 git 저장소에 스냅샷이 남으므로, 에이전트가
  한 모든 수정은 읽을 수 있는 diff이고 되돌릴 수 있는 버전입니다.

- **그 자리에서 고칩니다.** Dev Tools는 다른 앱을 고치는 앱입니다. 소스를 복제하고, 수정하고,
  결과를 라이브로 미리 보고, 다시 배포합니다 — 데스크톱을 떠나지 않고, 처음부터 다시 시작하지
  않고. "이거 나한테 맞게 바꿔줘"는 새 대화가 아니라 일급 작업입니다.

- **모든 앱은 계약을 말합니다.** 앱은 매니페스트를 공개합니다 — 타입이 있는 커맨드, 상태 키,
  이벤트 채널. 앱을 고치거나 조종하는 에이전트는 스크린샷이 아니라 스키마를 상대로 일합니다.
  `yaar://`를 말할 수 있는 에이전트라면 어떤 앱이든 다룰 수 있습니다.

- **에이전트는 당신 것을 씁니다.** YAAR는 이미 로그인된 Claude Code나 Codex를 서브프로세스로
  구동합니다. 계정도, API 키도, 호스팅 서비스도 없습니다. 대화는 원래 그 프로바이더가
  보내던 곳으로만 갑니다.

- **에이전트는 문단이 아니라 UI로 답합니다.** 분석을 요청하면 차트 창이 열립니다. 창은
  유지되고, 주소를 가지며, 개별적으로 메시지를 받을 수 있고, 데이터와 함께 살아 있습니다 —
  `yaar://` 리소스가 바뀌면 서버가 밀어 줍니다. 폴링도, 다시 물어보는 것도 없습니다.

- **동사 다섯 개, 평평한 프롬프트.** 창, 파일, 앱, 설정, 다른 에이전트까지 전부 `yaar://`
  URI이고, `describe · read · list · invoke · delete` 다섯 동사가 그 전부를 다룹니다. 기능
  탐색은 런타임에 일어나므로 앱이 3개든 100개든 시스템 프롬프트는 ~8K 토큰에 머뭅니다.

왜 TUI가 아니라 GUI인지, 왜 OS 모양인지, 왜 웹인지 — 그 이유가 궁금하다면 [FAQ](./docs/ko/faq.md)를 보세요.

## 데스크톱 전체가 입력입니다

| 입력                          | 일어나는 일                                  |
| ----------------------------- | -------------------------------------------- |
| 타이핑                        | 메시지 전송                                  |
| 이미지 붙여넣기 / 드래그 앤 드롭 | 에이전트에게 이미지 전송                      |
| 우클릭 드래그                 | 스케치 — 에이전트가 코드나 다이어그램으로 바꿉니다 |
| 창 안의 버튼 클릭             | 그 창의 액션 실행                            |
| 우클릭 → 창 선택              | 특정 창 하나에게 말하기                      |
| 파일/선택 영역을 앱으로 드래그 | 앱 사이에 데이터 이동                        |

## 앱 만들기

앱은 평범한 TypeScript에 필요한 것들이 딸려 옵니다:

- **번들 라이브러리** — Solid.js, lodash, Three.js, Konva, Chart.js, D3, Tone.js 등을 `@bundled/*`로 import, `npm install` 없이
- **`appDb`** — 앱별 격리 SQLite, Mongo 스타일 필터와 FTS5 전문 검색 ([가이드](./docs/ko/sqlite.md))
- **앱 에이전트** — `agent/prompt.md`를 추가하면 그 앱만의 에이전트가 생기고, `controls`를 선언하면 다른 앱을 조종할 수 있습니다
- **게이트된 SDK** — `app.json`에 선언하면 열립니다: `yaar-dev`(컴파일/배포), `yaar-web`(브라우저 자동화), `yaar-ml`(브라우저 내 ONNX 추론)
- **YAAR Market** — 카탈로그에서 설치하거나 직접 게시. 마켓은 소스를 배포하고, 설치는 로컬에서 컴파일합니다

자세한 내용은 [앱 개발 가이드](./docs/ko/app-development.md)를 보세요.

## 신뢰 모델

YAAR는 에이전트가 당신의 머신에서 코드를 쓰고 실행하게 하므로, 에이전트를 믿지 않는다는 전제로 만들어졌습니다:

- **범위가 정해진 파일시스템** — 에이전트가 보는 것은 `storage/`, `config/`, `apps/`, `session_logs/`뿐. 그 밖은 명시적으로 마운트해야 합니다 (읽기 전용 지원)
- **단일 접근 관문** — 모든 라우트가 *누가* 부르는지와 *어떤* URI + 동사인지를 같은 검사로 확인합니다
- **앱 권한** — 앱은 자기 네임스페이스와 `app.json`에 선언한 것만 만집니다. 나머지는 설치 시 물어봅니다
- **오리진 격리** — 앱은 데스크톱과 다른 브라우저 오리진에서 실행되므로 데스크톱 요청을 위조하거나 DOM에 닿을 수 없습니다
- **에이전트 등급** — 위험한 네임스페이스(`yaar://session/*`, 실제 브라우저 제어 포함)는 특권 세션 에이전트만 닿습니다
- **네트워크 허용 목록 + SSRF 방어** — 외부 HTTP는 승인된 도메인으로 제한되고, 내부 주소는 차단됩니다

샌드박스가 *막지 못하는* 것까지 포함한 전체 내용: [보안](./docs/ko/faq.md), [OS 아키텍처 맵](./docs/architecture/os_architecture.md).

## 그리고

- **여러 데스크톱** — 모니터마다 자기 에이전트와 히스토리가 있고, 세션 에이전트가 그 위에서 조율합니다. 탭을 닫아도 세션은 살아 있고, `?sessionId=X`로 다시 붙습니다.
- **원격 접속** — `make claude` / `make codex`가 QR 코드를 찍어 줍니다. [Tailscale Serve](https://tailscale.com)로 폰에서 접속하세요. [가이드](./docs/ko/remote_mode.md)
- **Hooks** — `config/hooks.json`으로 이벤트 기반 자동화. [가이드](./docs/ko/hooks.md)

```
브라우저 (UI) ←→ 로컬 서버 ←→ Claude Code / Codex
```

개발 환경과 아키텍처: [CLAUDE.md](./CLAUDE.md).

---

_YAAR: **Y**ou **A**re **A**bsolutely **R**ight — 에이전트를 많이 써 본 사람이라면 수백 번은 읽은 그 문장. 어차피 그 말을 할 거라면, 데스크톱도 맡기는 게 낫습니다._
