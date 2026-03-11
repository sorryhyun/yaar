# YAAR

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React_19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Bun](https://img.shields.io/badge/Bun_≥1.1-F9F1E1?logo=bun&logoColor=black)](https://bun.sh/)
[![MCP](https://img.shields.io/badge/MCP-F26922?logo=anthropic&logoColor=white)](https://modelcontextprotocol.io/)
[![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-D97757?logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/agents-and-tools/claude-agent-sdk)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

[한국어](./README.md)

> **Y**ou **A**re **A**bsolutely **R**ight — a reactive AI interface where the AI decides what to show and do next.

User actions like button clicks, drawing, and typing are sent not to a program, but to an AI. The AI interprets the user's intent and dynamically creates windows, tables, forms, and visualizations.

![YAAR Desktop](./docs/image.png)


## Quick Start

Codex or Claude Code authentication is required.

**Windows:** Install the [Codex CLI](https://github.com/openai/codex), then download `yaar.exe` from the Releases tab. You may see a SmartScreen warning (code signing not applied).

**Other platforms:**
```bash
git clone https://github.com/sorryhyun/yaar.git && cd yaar
bun install && make codex-types
make dev          # Browser opens automatically
```

Once running, start with something like "install essential apps".


## What You Can Do

- **"Analyze this CSV"** → AI reads the data and opens a chart window with visualizations
- **"Check my GitHub issues"** → GitHub Manager app displays and manages your issues
- **"Make a presentation"** → Slides Lite generates a slide deck
- **Right-click drag to sketch** → AI interprets your drawing and converts it to code or diagrams
- **"Build me a Tetris game"** → AI writes the code, builds it, and deploys a playable app


## How It Works

```
Browser (UI) ←→ Local Server ←→ Claude Code / Codex (AI)
```

You're essentially having a 1:1 conversation with Claude Code or Codex, but interacting through a UI instead of plain text.

On startup, the program creates `storage/, config/, apps/, session_logs/, sandbox/` folders. The AI **cannot access anything outside these folders.** Place any files you want to provide in these directories.


## Key Features

### AI Interprets and Renders

The AI responds by **directly creating UI** — opening windows or showing notifications to react to user actions.

| Input | Action |
|-------|--------|
| Typing | Send a message |
| Paste image / drag & drop | Send image to AI |
| Right-click drag | Draw and send sketch to AI |
| Button click | Execute in-window action |
| Right-click → select window | Send instructions to a specific window |
| Drag file/selection to app | Transfer data between apps |

User actions accumulate as context and are sent to the AI together when you submit a message. AI responses are automatically cached — identical instructions can instantly reuse previous responses.


### App Ecosystem

Bundled apps available from YAAR Market:

| App | Description |
|-----|-------------|
| 📁 Storage | File manager |
| 🌐 Browser | Live browser with screenshot streaming |
| 📊 Excel Lite | Spreadsheet with formula support |
| 📝 Word Lite | DOCX/Markdown document editor |
| 🎞️ Slides Lite | Presentation editor |
| 📄 PDF Viewer | PDF viewer |
| 🐙 GitHub Manager | GitHub issues & PR management |
| 📰 RSS Reader | Multi-feed RSS reader |
| 🖼️ Image Viewer | Image viewer |
| 🎬 Video Editor / Viewer | Video editing and playback |
| 📄 Recent Papers | Academic paper browser |
| 🕐 Dock | Clock, weather, and notification panel |

You can also develop your own apps. Bundled libraries (lodash, anime.js, Konva, Solid.js, etc.) are available without npm install, and code runs in an isolated sandbox. Built apps are **bundled into a single HTML file** that runs independently anywhere. See the [App Development Guide](./docs/app-development.md) for details.


### Multi-Monitor & Sessions

Create multiple **virtual desktops (monitors)** to organize your work. Each monitor has its own main agent and conversation history. Sessions persist across browser closures, and you can join the same session from another tab or device with `?sessionId=X`.


### Remote Access

Running with `make claude` or `make codex` automatically enables remote mode. A QR code is printed to the terminal — scan it with your phone for automatic token authentication and instant connection. SSH tunneling allows access from external networks. See the [Remote Access Guide](./docs/remote_mode.md) for details.


### Hooks

Set up event-driven automation with `config/hooks.json`. Automatically execute actions when specific events occur. See the [Hooks Guide](./docs/hooks.md) for details.


## Security

Since YAAR lets the AI execute code and communicate with external services, it ships with multiple security layers.

- **Sandbox isolation** — Runs in `node:vm` with `eval`/`import`/filesystem/WebAssembly disabled
- **Domain allowlist** — Only domains in `config/curl_allowed_domains.yaml` are permitted; new domains require user approval
- **MCP authentication** — Bearer token-based tool call authentication
- **Remembered permissions** — Allow/deny decisions persisted in `config/permissions.json`
- **Iframe isolation** — Apps run inside iframes, communicating with the server only via `postMessage`
- **Path validation** — Guards against path traversal attacks


## Project Structure

```
yaar/
├── apps/              # Drop folders here to create apps
├── config/            # User settings and credentials (git-ignored)
├── storage/           # AI-accessible file storage (git-ignored)
├── packages/
│   ├── shared/        # OS Actions, WebSocket events, Component DSL types
│   ├── server/        # WebSocket server + AI providers (Claude/Codex)
│   └── frontend/      # React frontend
```

YAAR's architecture can be interpreted through traditional OS concepts. `LiveSession` maps to the kernel, agents to processes, MCP tools to syscalls, and `storage/` to the filesystem. See the [OS Architecture Map](./docs/os_architecture.md) for the full mapping.

See [CLAUDE.md](./CLAUDE.md) for development details.
