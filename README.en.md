# YAAR

**Y**ou **A**re **A**bsolutely **R**ight — a reactive AI interface where the AI decides what to show and do next.

No pre-built screens. Just an **always-ready input field**. The AI creates windows, tables, forms, and visualizations dynamically based on your intent.

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                           Frontend                              │
│   ┌─────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│   │    Input    │    │    Canvas    │    │     Windows      │  │
│   │    Field    │    │   (Draw)     │    │    (Rendered)    │  │
│   └──────┬──────┘    └──────┬───────┘    └────────▲─────────┘  │
│          │                  │                     │             │
│          └────────┬─────────┘                     │             │
│                   ▼                               │             │
│            User Message                    OS Actions (JSON)    │
│                   │                               │             │
└───────────────────┼───────────────────────────────┼─────────────┘
                    │          WebSocket            │
┌───────────────────▼───────────────────────────────┼─────────────┐
│                         Server                    │             │
│   ┌───────────────────────────────────────────────┴──────────┐  │
│   │                      AI Provider                         │  │
│   │   • Interprets user intent                               │  │
│   │   • Injects dynamic context (apps, history)              │  │
│   │   • Emits OS Actions → Frontend renders                  │  │
│   └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Key Features

### 1. AI Interprets and Renders

The AI doesn't just respond with text — it **creates the UI**. Ask for a task list, and a window appears with checkboxes. Ask to compare data, and a table renders. You can also `Alt + Left-click drag` anywhere to sketch — the AI interprets your drawing to generate code or refine the design.

```
You: "Show me today's tasks"
 AI: Creates window with interactive task list
You: (wireframe sketch)
 AI: Interprets sketch and creates actual UI
```

### 2. Smart Context

The AI automatically picks up relevant context based on what you're doing. Click an app icon and it loads that app's skill; interact with a window and it receives the interaction context; previous results are retained in conversation history. When window content needs refreshing, a fingerprint-based cache restores it instantly without re-querying the AI.

### 3. App Development

Say "make me a Tetris game" and the AI writes TypeScript, compiles it with esbuild, and deploys it to your desktop. Bundled libraries (lodash, anime.js, Konva, etc.) are available without npm install, and code runs in an isolated sandbox.

For API-driven apps, describe the API in a `SKILL.md` file and the AI handles the rest.

See the [App Development Guide](./docs/app-development.md#english) for details.

### 4. Parallel Monitors and Windows

Work on multiple tasks simultaneously. **Monitors** (`Ctrl+1`–`Ctrl+4`) are independent workspaces — run a long task on Monitor 1 while continuing a different conversation on Monitor 0. Each **window** has its own agent, so requests to different windows are processed in parallel. When the main agent is busy, ephemeral agents are automatically spawned for new messages.

Sessions persist even after closing the browser tab; reconnect with `?sessionId=X` to restore state. See [`docs/monitor_and_windows_guide.md`](./docs/monitor_and_windows_guide.md) for details.

## Security

Since YAAR lets the AI execute code and communicate with external services, it ships with multiple security layers.

- **Sandbox isolation**: `run_js` code executes in `node:vm` with `eval`, `Function`, `require`, `import`, filesystem access, and WebAssembly all disabled.
- **Domain allowlist**: HTTP requests (`http_get`/`http_post`) and sandbox `fetch` are restricted to domains listed in `config/curl_allowed_domains.yaml`. New domains require user approval via a confirmation dialog.
- **MCP authentication**: MCP tool calls are authenticated with a Bearer token generated at server startup. Set `MCP_SKIP_AUTH=1` for local development.
- **Remembered permissions**: User allow/deny decisions are persisted in `config/permissions.json` so repeated requests don't re-prompt.
- **Credential isolation**: App credentials are stored in `config/credentials/` and git-ignored.
- **Path validation**: Storage and sandbox file access is guarded against path traversal.
- **CORS**: Only frontend dev server origins (`localhost:5173`, `localhost:3000`) are allowed.
- **Iframe isolation**: Compiled apps run inside iframes and communicate with the server only via `postMessage`.

## Quick Start

**Prerequisites:** Node.js >= 24, pnpm >= 10, Claude CLI (`npm install -g @anthropic-ai/claude-code && claude login`)

```bash
pnpm install    # Install dependencies
make dev        # Start YAAR
```

Open http://localhost:5173

## Project Structure

```
yaar/
├── apps/              # Drop folders here to create apps
├── packages/
│   ├── shared/        # OS Actions types
│   ├── server/        # WebSocket server + AI providers
│   └── frontend/      # React frontend
```

See [CLAUDE.md](./CLAUDE.md) for development details.
