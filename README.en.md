# YAAR

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React_19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Bun](https://img.shields.io/badge/Bun_≥1.1-F9F1E1?logo=bun&logoColor=black)](https://bun.sh/)
[![MCP](https://img.shields.io/badge/MCP-F26922?logo=anthropic&logoColor=white)](https://modelcontextprotocol.io/)
[![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-D97757?logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/agents-and-tools/claude-agent-sdk)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

[한국어](./README.md)

> **Y**ou **A**re **A**bsolutely **R**ight — a reactive AI interface where the AI decides what to show and do next.

![YAAR Desktop](./docs/image.png)

MCP tools, skills, plugins, and A2A — all within an 8K-token system prompt. Build apps, visualize data, and connect to external services.


## Install

Codex or Claude Code authentication is required.

```bash
curl -fsSL https://raw.githubusercontent.com/sorryhyun/yaar/master/install.sh | bash
yaar                # Browser opens automatically
```

Supports Linux, macOS (Intel & Apple Silicon), and Windows (WSL). Single binary — no Bun or Node.js required.

Windows (PowerShell): `irm https://raw.githubusercontent.com/sorryhyun/yaar/master/install.ps1 | iex`

Once running, start with something like "install essential apps".

<details>
<summary>Other install options</summary>

**Pin a version / custom install path:**
```bash
VERSION=v0.1.0 curl -fsSL ... | bash             # Specific version
INSTALL_DIR=/usr/local/bin curl -fsSL ... | bash  # Custom install path
```

**Windows:** You can also download `yaar.exe` directly from the [Releases page](https://github.com/sorryhyun/yaar/releases).

**Build from source** (requires [Bun](https://bun.sh/) >= 1.1):
```bash
git clone https://github.com/sorryhyun/yaar.git && cd yaar
bun install
make dev          # Browser opens automatically
```

</details>

Once running, start with something like "install essential apps".


## What You Can Do

- **"Analyze this CSV"** → AI reads the data and opens a chart window with visualizations
- **"Make a presentation"** → Slides Lite generates a slide deck with internal (chrome dev tool)
- **Right-click drag to sketch** → AI interprets your drawing and converts it to code or diagrams
- **"Build me a Tetris game"** → AI writes the code, builds it, and deploys a playable browser app in a static form.


## What's Different?

- **Everything runs on just 5 tools.** Agents discover tool descriptions on demand, keeping the initial context minimal. All I/O and functions are unified into URI-based "verb" handlers.

    <details>
    <summary>Compared to the traditional approach</summary>

    Traditional MCP servers register a separate tool for each capability. As apps and features grow, so does the tool count — and the system prompt.

    ```
    ❌ Traditional: tool count grows with features
    ┌──────────────────────────────────────┐
    │ read_file, write_file, delete_file,  │
    │ list_directory, create_window,       │
    │ update_window, close_window,         │
    │ get_app_info, install_app,           │
    │ send_notification, run_code,         │
    │ fetch_url, manage_config, ...        │
    │                                      │
    │ → 20+ tools (keeps growing)          │
    │ → System prompt 30K+ tokens          │
    └──────────────────────────────────────┘

    ✅ YAAR: all resources unified under URIs, accessed via 5 verbs
    ┌──────────────────────────────────────┐
    │ describe · read · list · invoke · delete │
    │                                      │
    │ describe('yaar://apps/slides-lite')  │
    │ → returns supported verbs, schema    │
    │                                      │
    │ invoke('yaar://windows/main', {...}) │
    │ read('yaar://storage/data.csv')      │
    │ list('yaar://apps')                  │
    │ delete('yaar://windows/old-panel')   │
    │                                      │
    │ → Install 100 apps, still 5 tools    │
    │ → System prompt stays under 8K tokens│
    └──────────────────────────────────────┘
    ```

    </details>

- **Skills, plugins, and UI are unified into a single concept: the 'app'.** One folder = one app. Install by adding a folder, uninstall by removing it.

    <details>
    <summary>Compared to the traditional approach</summary>

    Traditional AI tools have separate formats and registration flows for skills, plugins, and custom UI. YAAR unifies all of these into a single folder convention.

    ```
    ❌ Traditional: different formats for each role
    ┌──────────────────────────────────────┐
    │ skills/                              │
    │   slide-maker.yaml    ← AI ability  │
    │ plugins/                             │
    │   slide-export.js     ← server ext  │
    │ ui-components/                       │
    │   slide-viewer.tsx    ← frontend    │
    │ configs/                             │
    │   slide-settings.json ← settings    │
    │                                      │
    │ → Scattered across 4 locations       │
    │ → Each requires its own registration │
    └──────────────────────────────────────┘

    ✅ YAAR: one folder = one app
    ┌──────────────────────────────────────┐
    │ apps/slides-lite/                    │
    │   app.json         ← metadata       │
    │   SKILL.md         ← AI-readable doc│
    │   AGENTS.md        ← app agent def  │
    │   src/main.ts      ← UI + logic     │
    │   dist/                              │
    │     index.html     ← built output   │
    │     protocol.json  ← state/commands │
    │                                      │
    │ → Drop folder to install, delete to  │
    │   uninstall. Zero registration code. │
    │ → Builds to a single HTML file.      │
    └──────────────────────────────────────┘
    ```

    </details>

- **Permissions are explicitly separated and visible.** App access scope, filesystem, and network are all transparent and user-controlled.

    <details>
    <summary>Compared to the traditional approach</summary>

    Traditional AI tools grant broad access once authorized. YAAR isolates app storage, enforces a domain allowlist, and records every approval decision.

    ```
    ❌ Traditional: permissions are implicit and global
    ┌──────────────────────────────────────┐
    │ Grant AI file access                 │
    │ → Full filesystem access             │
    │ → No visibility into what was read   │
    │ → Network requests unrestricted      │
    └──────────────────────────────────────┘

    ✅ YAAR: permissions are explicit and scoped
    ┌──────────────────────────────────────┐
    │ app.json                             │
    │ { "permissions": [                   │
    │     "yaar://apps/self/storage/"      │
    │   ] }                                │
    │ → App can only access its own storage│
    │                                      │
    │ config/curl_allowed_domains.yaml     │
    │ allowed_domains:                     │
    │   - github.com                       │
    │   - api.example.com                  │
    │ → Only listed domains are allowed    │
    │ → New domains require user approval  │
    │                                      │
    │ config/permissions.json              │
    │ → Every allow/deny decision is logged│
    └──────────────────────────────────────┘
    ```

    </details>

- **The AI responds with UI, not text.** Instead of markdown replies, it opens windows, shows notifications, and manipulates apps to react to your actions.

    <details>
    <summary>Compared to the traditional approach</summary>

    Traditional AI tools respond with text or markdown. If you need a UI, you build a separate frontend.

    ```
    ❌ Traditional: text-based responses
    ┌──────────────────────────────────────┐
    │ User: "Analyze this CSV"             │
    │ AI: "Here are the results:\n- Avg: 42│
    │                                      │
    │ → Need a chart? Run separate code    │
    │ → Interaction? Not possible          │
    └──────────────────────────────────────┘

    ✅ YAAR: AI responds with UI directly
    ┌──────────────────────────────────────┐
    │ User: "Analyze this CSV"             │
    │ AI: invoke('yaar://windows/chart',   │
    │       { renderer: "iframe", ... })   │
    │                                      │
    │ → Chart window opens                 │
    │ → Click, drag, interact              │
    │ → Responses cached for instant reuse │
    └──────────────────────────────────────┘
    ```

    | Input | Action |
    |-------|--------|
    | Typing | Send a message |
    | Paste image / drag & drop | Send image to AI |
    | Right-click drag | Draw and send sketch to AI |
    | Button click | Execute in-window action |
    | Right-click → select window | Send instructions to a specific window |
    | Drag file/selection to app | Transfer data between apps |

    </details>


## How It Works

```
Browser (UI) ←→ Local Server ←→ Claude Code / Codex (AI)
```

On startup, the program creates `storage/, config/, apps/, session_logs/` folders. The AI **cannot access anything outside these folders.** To give the AI access to an external directory, use the "Mount..." button in the Storage app — specify an alias and path, and it becomes available at `storage/mounts/{alias}/` with optional read-only protection.


## Key Features

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

Create multiple **virtual desktops (monitors)** to organize your work. Each monitor has its own monitor agent and conversation history. Sessions persist across browser closures, and you can join the same session from another tab or device with `?sessionId=X`.


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
