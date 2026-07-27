# 원격 모드

> [English version](../guides/remote_mode.md)

원격 모드를 사용하면 네트워크 상의 다른 기기(휴대폰, 태블릿, 다른 PC)에서 토큰 기반 인증으로 YAAR에 접속할 수 있습니다.

## 빠른 시작

```bash
make claude   # Claude 프로바이더로 시작 (원격 모드)
make codex    # Codex 프로바이더로 시작 (원격 모드)
```

서버가 연결 배너를 출력합니다:

```
╔══════════════════════════════════════════════════╗
║              YAAR Remote Mode                   ║
╠══════════════════════════════════════════════════╣
║  Server:  http://192.168.1.100:8000
║  Token:   <random-token>
╠══════════════════════════════════════════════════╣
║  Connect: http://192.168.1.100:8000/#remote=<token>
╚══════════════════════════════════════════════════╝
```

`qrcode-terminal`이 설치되어 있으면 모바일에서 쉽게 스캔할 수 있도록 QR code도 함께 출력됩니다.

## 접속하기

다른 기기에서 접속하는 세 가지 방법:

1. **QR code** — 터미널에 출력된 QR code를 휴대폰 카메라로 스캔
2. **URL** — `Connect:` URL을 브라우저에서 직접 열기
3. **수동** — 호스팅된 프론트엔드를 아무거나 열고, 연결 대화상자에 서버 URL과 토큰을 입력

프론트엔드는 연결 방식을 자동으로 감지합니다:
- 해시 프래그먼트(`#remote=<token>`) → 자동 연결 후 localStorage에 저장
- localStorage에 저장된 연결 정보 → 검증 후 재연결
- 로컬 서버의 `/health` 응답 → 로컬 모드(인증 없음)
- 아무것도 없음 → 연결 대화상자 표시

## 로컬 개발 (인증 없음)

```bash
make claude-dev   # Claude, 로컬 전용, MCP 인증 없음
make codex-dev    # Codex, 로컬 전용, MCP 인증 없음
make dev          # 프로바이더 자동 감지, 로컬 전용
```

이전과 동일하게 토큰 인증 없이 `127.0.0.1`에 바인딩됩니다.

## 인증 동작 방식

- `REMOTE=1` 환경 변수가 원격 모드를 활성화합니다
- 서버가 시작 시 무작위 32바이트 base64url 토큰을 생성합니다
- 서버가 `127.0.0.1` 대신 `0.0.0.0`(모든 인터페이스)에 바인딩됩니다 — 단, [Tailscale Serve](#lan-바인딩-없음)에서는 루프백에 머뭅니다
- 모든 HTTP 엔드포인트는 `Authorization: Bearer <token>` 헤더 또는 `?token=` 쿼리 파라미터를 요구합니다
- WebSocket 업그레이드는 `?token=` 쿼리 파라미터를 요구합니다
- `/health` 엔드포인트는 (연결 테스트를 위해) 항상 예외입니다
- 원격 모드에서는 CORS가 모든 오리진을 허용합니다(로컬 모드는 localhost만 허용)

## 내장 터널 (자동)

원격 모드에서 YAAR는 [localhost.run](https://localhost.run)을 통해 SSH 리버스 터널을 자동으로 구성합니다 — 별도 설정도, 가입도, 추가 바이너리도 필요 없습니다. 서버를 시작하고 어디서든 QR code를 스캔하기만 하면 됩니다.

**요구 사항:** 머신에 SSH 키(`~/.ssh/id_ed25519`, `id_rsa`, 또는 `id_ecdsa`)가 있어야 합니다. 대부분의 개발 머신에는 이미 있습니다. 없다면 `ssh-keygen`을 실행하세요.

### 동작 방식

1. 서버가 원격 모드로 시작 → 디스크(또는 SSH 에이전트)에서 SSH 키를 감지
2. SSH로 `localhost.run`에 연결해 리버스 터널을 요청
3. `localhost.run`이 공개 HTTPS URL을 할당(예: `https://abc123.lhr.life`)
4. 배너와 QR code에 터널 URL이 표시됨 — 외부 클라이언트는 이를 통해 연결
5. 터널 연결이 실패하면(SSH 키 없음, 인터넷 없음) 서버는 LAN 전용 모드로 계속 동작

### 터널 배너

```
╔══════════════════════════════════════════════════╗
║              YAAR Remote Mode                   ║
╠══════════════════════════════════════════════════╣
║  Server:  http://192.168.1.100:8000
║  Tunnel:  https://abc123.lhr.life/#remote=<token>
║  Token:   <random-token>
╠══════════════════════════════════════════════════╣
║  Connect: https://abc123.lhr.life/#remote=<token>   ← QR encodes this
╚══════════════════════════════════════════════════╝
```

### 자동 터널 비활성화

`config/tunnel.json`을 생성하세요:
```json
{ "disabled": true }
```

### 커스텀 SSH 서버

localhost.run 대신, 자신의 서버를 통해 터널링할 수도 있습니다:

```json
{
  "host": "myserver.com",
  "username": "deploy",
  "privateKeyPath": "~/.ssh/id_ed25519",
  "remotePort": 8000,
  "publicHost": "myserver.com"
}
```

| 필드 | 타입 | 기본값 | 설명 |
|-------|------|---------|-------------|
| `host` | string | **(필수)** | SSH 서버 호스트명 |
| `port` | number | `22` | SSH 포트 |
| `username` | string | **(필수)** | SSH 사용자명 |
| `privateKeyPath` | string | — | 개인 키 경로(`~`는 홈 디렉터리로 해석됨) |
| `password` | string | — | 비밀번호 인증 폴백 |
| `remotePort` | number | 로컬 `PORT`와 동일 | 원격 서버에서 포워딩할 포트 |
| `remoteHost` | string | `"0.0.0.0"` | 원격 서버의 바인딩 주소 |
| `publicHost` | string | `host`와 동일 | 공개 URL에 사용할 호스트명 |
| `publicHttps` | boolean | `false` | 공개 URL에 `https://` 사용 여부 |

인증 우선순위: `privateKeyPath` → `password` → `SSH_AUTH_SOCK` 에이전트.

### Tailscale Serve (관리형, tailnet 전용)

공개 터널 대신, [Tailscale](https://tailscale.com) tailnet을 통해 YAAR를 노출할 수 있습니다. 이미 tailnet에 속한 기기만 접근할 수 있으므로 — 토큰으로만 막는 공개 URL보다 엄격히 강한 네트워크 계층 인증입니다. 추가 설정 없이 실제 HTTPS 인증서(`https://<host>.<tailnet>.ts.net`)도 얻고, 리모트 모드에서 [앱 오리진 격리](#네트워크-너머의-앱-오리진-격리)를 유지하는 **유일한** 전송 방식입니다.

`config/tunnel.json`을 만드세요:
```json
{ "service": "tailscale" }
```

| 필드 | 타입 | 기본값 | 설명 |
|-------|------|---------|-------------|
| `service` | `"tailscale"` | — | Tailscale Serve 프로바이더 선택 |
| `tailscalePath` | string | `PATH`에서 탐색(macOS 앱 번들 포함) | `tailscale` 바이너리의 절대 경로 |
| `appOriginPort` | number | `8443` | 격리된 **앱 오리진**을 제공할 공개 HTTPS 포트. 443은 사용할 수 없음 |

**요구 사항:** `tailscale` CLI가 설치되어 tailnet에 로그인되어 있어야 하고(`tailscale up`), tailnet에 **HTTPS 인증서**가 활성화되어 있어야 합니다([관리 콘솔](https://login.tailscale.com/admin/dns)에서 MagicDNS와 HTTPS Certificates 켜기). 그렇지 않으면 `serve --https=443`이 실패하고 YAAR가 해결 방법을 출력합니다.

#### LAN 바인딩 없음

`REMOTE=1`은 보통 `0.0.0.0`에 바인딩하지만, Tailscale에서는 `tailscaled`가 `127.0.0.1`로 YAAR에 접근하므로 LAN 바인딩은 불필요한 노출일 뿐입니다. 따라서 YAAR는 **루프백에 머물며**, tailnet(데몬 경유)과 이 기기만 연결할 수 있습니다.

이 판단은 터널이 실제로 연결됐는지가 아니라 `tunnel.json`의 의도를 따릅니다. `tailscaled`가 꺼져 있으면 LAN 전용이 아니라 **localhost 전용**이 됩니다 — tailnet 전용을 요청한 사용자가 데몬이 안 떠 있다는 이유로 LAN 전체를 베어러 토큰 하나에 노출당해서는 안 되기 때문입니다.

#### 네트워크 너머의 앱 오리진 격리

YAAR는 같은 MagicDNS 이름에 포트만 다른 **두 번째** serve 규칙을 등록합니다:

```
https://my-box.tailnet-abc.ts.net        → http://127.0.0.1:8000   데스크톱
https://my-box.tailnet-abc.ts.net:8443   → http://127.0.0.1:8001   설치된 앱
```

포트가 다르면 브라우저 오리진이 다르므로(동일 출처 정책은 포트도 구분함), 설치된 앱 iframe은 로컬의 `localhost`/`127.0.0.1`과 똑같이 다시 데스크톱과 크로스 오리진이 됩니다. MagicDNS 이름은 안정적이지만 localhost.run의 서브도메인은 매번 바뀌므로, 이것이 가능한 전송 방식은 Tailscale뿐입니다.

두 공개 포트를 의도적으로 **서로 다른 두 로컬 소켓**에 연결합니다. 프록시 뒤에서는 브라우저가 어느 오리진을 호출했는지 서버가 읽을 수 없기 때문에(`Host`와 `X-Forwarded-*`는 프록시의 주장일 뿐), 위조할 수 없는 *요청이 도착한 소켓*으로 판단합니다. 두 번째 규칙 등록이 실패하면 데스크톱 터널은 유지하고 격리만 끈 상태로 동작합니다.

### 터널 동작

- 원격 모드(`REMOTE=1` 또는 번들 실행 파일)에서만 활성화됩니다
- 연결에 성공하면 배너와 QR code가 LAN URL 대신 터널 URL을 사용합니다
- 시작 시 연결에 실패하면 경고가 로그에 남고 서버는 LAN 전용으로 계속 동작합니다 — [루프백 바인딩 전송](#lan-바인딩-없음)에서는 localhost 전용
- 성공 후 연결이 끊기면 지수 백오프(1초 → 최대 30초)로 자동 재연결합니다
- 종료 시(`Ctrl+C`) 3초 타임아웃으로 터널이 정상적으로 닫힙니다
- Keepalive: 15초 간격, 최대 3회 하트비트 누락까지 허용

## 외부 터널링 (대안)

내장 터널 없이 LAN을 넘어선 접속이 필요하다면 외부 도구를 사용하세요:

**Cloudflare Tunnel(권장):**
```bash
cloudflared tunnel --url http://localhost:8000
```

**SSH 터널(수동):**
```bash
ssh -R 8000:localhost:8000 your-server.com
```

**bore:**
```bash
bore local 8000 --to bore.pub
```

**Tailscale:**
같은 tailnet에 속한 기기는 LAN URL로 바로 연결할 수 있습니다. 배너/QR에 HTTPS MagicDNS URL이 나오는 관리형 설정을 원하면 내장 [Tailscale Serve](#tailscale-serve-관리형-tailnet-전용) 프로바이더(`config/tunnel.json` → `{ "service": "tailscale" }`)를 사용하세요.

외부 터널을 사용할 때, 프론트엔드의 연결 대화상자는 터널 URL을 서버 URL로 그대로 받아들입니다.

## 보안 모델

- 토큰은 서버가 시작될 때마다 새로 생성되며(영속되지 않음)
- 토큰은 URL 해시 프래그먼트(`#remote=token`)로 전달되는데, 브라우저는 이를 서버로 **전송하지 않으므로** 클라이언트 측에만 머뭅니다
- 프론트엔드는 재연결을 위해 연결 정보를 localStorage에 저장합니다
- 모든 API 및 WebSocket 요청에 토큰이 포함됩니다
- 기본적으로 HTTPS는 사용되지 않습니다 — 인터넷을 통한 암호화된 연결이 필요하면 터널(Cloudflare 등)을 사용하세요

### 앱 오리진 격리

**앱 오리진 격리**는 설치된(`source:'user'`) 앱을 데스크톱과 다른 브라우저 오리진에서 제공합니다. 크로스 오리진이므로 브라우저는 악성 앱이 `window.parent`를 통해 데스크톱의 DOM이나 JS 메모리에 접근하는 것을 막고, 격리된 앱 프레임은 추가로 샌드박스가 적용되어 최상위 창을 피싱 페이지로 이동(`window.top.location`)시킬 수도 없습니다. 악성 앱은 자신의 `app.json`이 선언한 범위로 제한됩니다. 기본값은 켜짐이며 `YAAR_APP_ORIGIN_ISOLATION=0`으로 끌 수 있습니다.

경계는 결국 "하나의 서버 위 두 개의 브라우저 오리진"일 뿐이고 모든 전송 방식이 두 오리진을 게시할 수 있는 것은 아니므로, 리모트 모드에 경계가 존재하는지는 **전송 방식에 달려 있습니다**:

| 전송 방식 | 오리진 분리 | 악성 앱 격리 |
|-----------|--------------|--------------|
| 로컬(기본) | `localhost` / `127.0.0.1` | ✅ |
| **Tailscale Serve** | `…ts.net` / `…ts.net:8443` ([위 참고](#네트워크-너머의-앱-오리진-격리)) | ✅ |
| localhost.run(리모트 기본) | 없음 — 서브도메인이 매번 바뀜 | ❌ |
| 자체 SSH 서버 / 외부 터널 | 없음 | ❌ |

경계가 존재할 수 없는 경우 **앱은 데스크톱과 같은 오리진(same-origin)으로 제공됩니다.** same-origin 프레임은 이에 대해 의미 있게 샌드박스할 수 없습니다(`allow-scripts allow-same-origin`이면 프레임이 자신의 부모에 접근해 자기 샌드박스 속성을 제거할 수 있음). 결과적으로 **악성 설치 앱이 데스크톱의 DOM과 JS 메모리에 직접 접근할 수 있습니다.** 로컬 모드에서 `YAAR_APP_ORIGIN_ISOLATION=0`을 설정한 경우에도 마찬가지입니다.

그때의 방어선은 *누가 연결할 수 있는가*를 통제하는 토큰뿐이며, 이는 본인이 직접 설치한 앱에 대해서는 아무것도 보장하지 않습니다. 그러므로 경계가 없는 전송 방식에서는 **신뢰하지 않는 앱을 설치하지 마세요.** 신뢰할 수 없는 앱과 데스크톱 무결성이 모두 필요하다면 Tailscale Serve를 쓰거나 로컬 모드를 유지하세요.

알아 둘 점 하나: 격리된 앱의 요청은 리모트 토큰이 아니라 자신의 **iframe 토큰**으로 인증합니다. 애초에 리모트 토큰은 헤더가 아니라 `Referer`에서 읽혔고, 그것은 앱이 same-origin일 때만 통했습니다(기본 리퍼러 정책은 크로스 오리진 `Referer`를 오리진만 남기고 잘라냅니다). iframe 토큰은 어차피 더 좁은 자격 증명입니다 — 서버가 발급하고, 창과 앱 하나에 묶여 있으며, 만료되고, 여전히 앱이 선언한 권한의 통제를 받습니다.

## 문제 해결

**연결 대화상자에 "Server not reachable"이 표시될 때:**
- 서버가 실행 중인지, URL이 올바른지 확인하세요
- 방화벽이 서버 포트(기본값 8000)로의 연결을 허용하는지 확인하세요
- 클라이언트 기기에서 서버 IP로 ping을 시도해 보세요

**"Invalid token":**
- 토큰은 서버가 재시작될 때마다 재생성됩니다 — 터미널에서 새 토큰을 확인하세요
- 토큰을 붙여넣을 때 뒤에 공백이 붙지 않았는지 확인하세요

**페이지를 새로고침하면 연결이 끊길 때:**
- 프론트엔드가 연결 정보를 localStorage에 저장하므로 자동으로 재연결되어야 합니다
- 서버가 재시작되었다면 새 토큰이 필요합니다

**WebSocket 연결 실패:**
- 일부 프록시/방화벽은 WebSocket 업그레이드를 차단합니다
- WebSocket을 지원하는 터널(Cloudflare Tunnel, bore 등)을 사용해 보세요
