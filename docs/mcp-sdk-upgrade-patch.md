# Claude Agent SDK 업그레이드 패치 가이드

## 배경

`@anthropic-ai/claude-agent-sdk`를 `0.2.53` → `0.2.56`으로 업그레이드.
이 과정에서 전이 의존성인 `@modelcontextprotocol/sdk`가 `1.25.3` → `1.27.1`로 같이 올라감.

## 증상

업그레이드 후 Claude 에이전트에서 모든 MCP 도구가 `"No such tool available"` 에러를 반환함.

서버 로그에는 MCP 서버 초기화 성공이 표시되고 요청도 들어오지만, 에이전트가 실제로 도구를 사용하려 하면 전부 실패.

## 원인

Claude Agent SDK 0.2.56이 가져오는 `@modelcontextprotocol/sdk` 1.27.x에서 `StreamableHTTPServerTransport`의 stateless 모드 동작이 변경됨.

**1.25.x:** stateless transport(`sessionIdGenerator: undefined`)를 여러 요청에 재사용 가능
**1.27.x:** stateless transport는 **단 한 번의 요청만 처리 가능**. 두 번째 요청부터 예외 발생:

```
Stateless transport cannot be reused across requests.
Create a new transport per request.
```

기존 코드는 서버 시작 시 MCP 서버당 transport를 **하나만** 생성하고 모든 요청에 재사용했기 때문에:

1. 첫 번째 요청 (`initialize`) → 성공
2. 이후 요청 (`tools/list`, `tools/call`) → **전부 실패**
3. Agent SDK가 도구 목록을 받지 못해 "No such tool available" 보고

## 수정 내용

### 1. `packages/server/src/mcp/server.ts` — stateful 세션 패턴으로 전환

**핵심 변경:** 시작 시 transport 1개 생성 → 요청마다 세션 기반 transport 생성

#### Before (깨진 코드)
```ts
// 시작 시 서버당 transport 1개 생성 — 1.27.x에서 깨짐
for (const name of MCP_SERVERS) {
  const server = new McpServer({ name, version: '1.0.0' }, { capabilities: { tools: {} } });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless 모드
  });
  await server.connect(transport);
  mcpServers.set(name, { server, transport });
}

// 요청 처리 — 두 번째 요청부터 실패
await entry.transport.handleRequest(req, res);
```

#### After (수정된 코드)
```ts
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

// 세션별 transport 저장소
const mcpSessions = new Map<string, McpSessionEntry>();

// initMcpServer()에서는 토큰 생성 + 브라우저 감지만 수행
// 실제 McpServer 인스턴스는 요청 시 on-demand로 생성

async function handleMcpRequest(req, res, serverName) {
  const mcpSessionId = req.headers['mcp-session-id'];

  if (mcpSessionId) {
    // 기존 세션 — transport 재사용
    const entry = mcpSessions.get(`${serverName}:${mcpSessionId}`);
    if (entry) {
      await entry.transport.handleRequest(req, res);
      return;
    }
    // 세션 없으면 404
    res.writeHead(404, ...);
    return;
  }

  // 세션 ID 없음 — initialize 요청이어야 함
  const body = await readJsonBody(req);
  const messages = Array.isArray(body) ? body : [body];
  if (!messages.some(m => isInitializeRequest(m))) {
    res.writeHead(400, ...);
    return;
  }

  // 새 McpServer + stateful transport 생성
  const server = await createServerForName(serverName);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),  // stateful 모드!
    enableJsonResponse: true,
    onsessioninitialized: (newSessionId) => {
      mcpSessions.set(`${serverName}:${newSessionId}`, { server, transport });
    },
  });

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) mcpSessions.delete(`${serverName}:${sid}`);
  };

  await server.connect(transport);
  await transport.handleRequest(req, res, body);  // body를 parsedBody로 전달
}
```

**주요 포인트:**
- `sessionIdGenerator: () => randomUUID()` — stateful 모드로 전환
- `enableJsonResponse: true` — JSON 응답 활성화
- `onsessioninitialized` 콜백으로 세션 저장
- `transport.onclose`로 세션 정리
- `readJsonBody()`로 body를 미리 파싱하여 `isInitializeRequest()` 검사 후 `handleRequest(req, res, body)`에 전달

### 2. `packages/server/src/mcp/user/index.ts` — 도구 이름 prefix 수정

```diff
-export const USER_TOOL_NAMES = ['ask', 'request'] as const;
+export const USER_TOOL_NAMES = ['mcp__user__ask', 'mcp__user__request'] as const;
```

모든 다른 `*_TOOL_NAMES`는 `mcp__<server>__<tool>` 형식을 사용하는데 user만 bare name이었음. `getToolNames()`에서 SDK의 `allowedTools`로 전달되므로 정확한 이름이 필요함.

## 버전 정리

| 패키지 | Before | After |
|--------|--------|-------|
| `@anthropic-ai/claude-agent-sdk` | 0.2.53 | 0.2.56 |
| `@modelcontextprotocol/sdk` | 1.25.3 | 1.27.1 (전이 의존성으로 같이 업그레이드) |

## 수정 파일 요약

| 파일 | 변경 | 이유 |
|------|------|------|
| `mcp/server.ts` | stateless → stateful 세션 패턴 | MCP SDK 1.27.x에서 stateless transport 재사용 불가 |
| `mcp/user/index.ts` | tool name에 `mcp__user__` prefix 추가 | 다른 도구와 naming convention 통일 |
