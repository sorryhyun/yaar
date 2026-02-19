# YAAR

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React_19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Bun](https://img.shields.io/badge/Bun_≥1.1-F9F1E1?logo=bun&logoColor=black)](https://bun.sh/)
[![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![Zustand](https://img.shields.io/badge/Zustand-433E38?logo=react&logoColor=white)](https://zustand.docs.pmnd.rs/)
[![Zod](https://img.shields.io/badge/Zod_v4-3E67B1?logo=zod&logoColor=white)](https://zod.dev/)
[![WebSocket](https://img.shields.io/badge/WebSocket-010101?logo=socketdotio&logoColor=white)](#)
[![MCP](https://img.shields.io/badge/MCP-F26922?logo=anthropic&logoColor=white)](https://modelcontextprotocol.io/)
[![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-D97757?logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/agents-and-tools/claude-agent-sdk)
[![pnpm](https://img.shields.io/badge/pnpm-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**Y**ou **A**re **A**bsolutely **R**ight — a reactive AI interface where the AI decides what to show and do next.

User actions like button clicks, drawing, and typing are sent not to a program, but to an AI. The AI interprets the user's intent and dynamically creates windows, tables, forms, and visualizations.

![YAAR Desktop](./docs/image.png)


## Basic Structure

The program consists of a browser, a local server (on the user's machine), and Codex/Claude Code.

All UI runs in the browser. Actions in the browser are sent to the local server, the server signals the Codex or Claude Code AI, the AI signals back to the server, and the result is sent back to the browser for display.

In essence, you're having a 1:1 conversation with Codex or Claude Code, but instead of plain text, you interact through a UI.

On startup, the program automatically creates `storage/, config/, apps/, session_logs/, sandbox/` folders. The AI **cannot access anything outside these folders.** If you want to provide files, place them in these folders. Files are preserved even after the program exits.


## Key Features

### 1. AI Interprets and Renders

The AI responds by **directly creating UI**. It opens "windows" or displays "messages" in the browser to respond to user actions. Users can type in the input field at the bottom center, paste images, drag and drop, click buttons on screen, right-click to send instructions to a specific window, or **Alt + left-click drag to draw** and send it to the AI. For convenience, actions like drag-selecting multiple apps or typing are not sent to the AI immediately.


### 2. Smart Context

Most user actions are first saved as context. When you click a button or send a message, all accumulated context is included and sent to the AI. When the AI responds, **your instructions + context and the AI's response are recorded**, so when you give the same instruction later, the AI is offered the option to **reuse that response**, performing the same task much faster than before. Records are stored in `config/reload-cache/` and can be managed at any time.


### 3. App Development

Sometimes you need pre-built programs. Since essential apps like the storage folder and browser are needed, YAAR operates a separate YAAR Market website. Currently, **only a small number of apps made by me are listed, and users cannot upload, so there are no security concerns.** Tell the AI "install essential apps" and it will install browser, storage folder, spreadsheet, word processor, etc. from the market.

You may also want to develop apps yourself, so YAAR supports programming capabilities. Various libraries are bundled, so you can develop the apps you need and deploy them to the desktop. Bundled libraries (lodash, anime.js, Konva, etc.) are available without npm install, and code runs in an isolated sandbox. The development environment is strictly configured, so there are minimal security concerns even when letting the AI develop autonomously.

See the [App Development Guide](./docs/app-development.md) for details.


## Getting Started

Codex or Claude Code user authentication is required. The program cannot be used without it.

For Windows users, install the [Codex CLI](https://github.com/openai/codex) and download `yaar-codex.exe` from the Releases tab. You may see a SmartScreen warning — this is because I haven't paid for code signing, so please bear with it. Once launched, a browser window opens immediately. Start by saying something like "install essential apps".

For other users, clone this repository, install [Bun](https://bun.sh/) and pnpm, then run `pnpm install` and `make codex-types` to set up, and `make dev` to start. You'll have a more stable environment than the Windows executable.


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
