# YAAR

**Software you can rewrite, keep, and share — in a shape any agent can drive.**

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React_19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Bun](https://img.shields.io/badge/Bun_≥1.3-F9F1E1?logo=bun&logoColor=black)](https://bun.sh/)
[![MCP](https://img.shields.io/badge/MCP-F26922?logo=anthropic&logoColor=white)](https://modelcontextprotocol.io/)
[![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-D97757?logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/agents-and-tools/claude-agent-sdk)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

[한국어](./README.ko.md)

![YAAR Desktop](./docs/assets/image.png)

YAAR is a local desktop where the agent you already use — Claude Code or Codex — builds the
apps, and you change them by talking to the app you're looking at. Every app is a folder on
your disk with its own git history. Nothing is hosted, nothing is rented.

```
"Build me a Tetris game"                 → writes it, builds it, opens it
"Make the pieces fall faster"            → edits the running app in place, redeploys, restores it
"Undo that"                              → rolls back to the previous deploy
"Publish it"                             → ships the source to YAAR Market
```

Chat assistants regenerate; app stores make you rebuild and resubmit. YAAR is the thing in
between: an app you're using is an app you can rewrite, right there, with the agent that wrote it.

## Install

Codex or Claude Code authentication is required.

```bash
curl -fsSL https://github.com/sorryhyun/yaar/releases/latest/download/install.sh | bash
yaar                # Browser opens automatically
```

Supports Linux, macOS (Intel & Apple Silicon), and Windows (WSL). Single binary — no Bun or Node.js required.

Windows (PowerShell): `irm https://github.com/sorryhyun/yaar/releases/latest/download/install.ps1 | iex`

Once running, start with something like "install essential apps".

<details>
<summary>Other install options</summary>

**Pin a version / custom install path:**

```bash
VERSION=v0.18.1 curl -fsSL ... | bash             # Specific version (default: latest)
INSTALL_DIR=/usr/local/bin curl -fsSL ... | bash  # Install path (default: ~/.local/bin)
```

**Windows:** You can also download `yaar.exe` directly from the [Releases page](https://github.com/sorryhyun/yaar/releases).

Bundled apps ship separately as `yaar-apps.tar.gz`; the install scripts extract them next to the binary automatically.

**Build from source** (requires [Bun](https://bun.sh/) >= 1.4):

```bash
git clone https://github.com/sorryhyun/yaar.git && cd yaar
bun install
make dev          # Browser opens automatically
```

</details>

## Why YAAR

- **You own the app.** One folder = one app: `app.json`, source, and an optional agent prompt,
  compiled to a single self-contained HTML file. Drop it in to install, delete it to uninstall,
  `git` it wherever you like. Every deploy is snapshotted to a shadow git repo, so any edit the
  agent makes is a diff you can read and a version you can restore.

- **You edit it in place.** Dev Tools is an app that edits other apps: it clones the source,
  changes it, previews the result live, and redeploys — without leaving the desktop and without
  starting over. "Customize this for me" is a first-class operation, not a new conversation.

- **Every app speaks a contract.** An app publishes a manifest — typed commands, state keys,
  event channels — so the agent that edits or drives it works against a schema, not a
  screenshot. Any agent that can speak `yaar://` can drive any app.

- **You bring your own agent.** YAAR drives Claude Code or Codex as a subprocess using the login
  you already have. No account, no API key, no hosted service; your conversations go wherever
  your provider already sends them, nowhere else.

- **The agent answers with UI, not paragraphs.** Ask for an analysis and you get a chart window.
  Windows persist, are addressable, can be messaged individually, and stay live with their data —
  the server pushes updates when a `yaar://` resource changes, no polling, no re-asking.

- **Five verbs, flat prompt.** Everything — windows, files, apps, config, other agents — is a
  `yaar://` URI, and `describe · read · list · invoke · delete` operate on all of it. Capability
  discovery happens at runtime, so the system prompt stays ~8K tokens with 3 apps or 100.

Curious about the reasoning — why a GUI instead of a TUI, why it's shaped like an OS, why the
web? See the [FAQ](./docs/faq.md).

## The whole desktop is an input

| Input                          | What happens                             |
| ------------------------------ | ---------------------------------------- |
| Typing                         | Send a message                           |
| Paste image / drag & drop      | Send an image to the agent               |
| Right-click drag               | Sketch — the agent turns it into code or diagrams |
| Button click inside a window   | Execute that window's action             |
| Right-click → select window    | Talk to one specific window              |
| Drag a file/selection to an app | Move data between apps                  |

## Build apps

Apps are plain TypeScript with batteries included:

- **Bundled libraries** — Solid.js, lodash, Three.js, Konva, Chart.js, D3, Tone.js and more via `@bundled/*`, no `npm install`
- **`appDb`** — per-app isolated SQLite with Mongo-style filters and FTS5 full-text search ([reference](./docs/reference/app_db_reference.md))
- **App agents** — add `agent/prompt.md` and the app gets its own agent; declare `controls` and it can drive other apps
- **Gated SDKs** — declare them in `app.json` to unlock `yaar-dev` (compile/deploy), `yaar-web` (browser automation), `yaar-ml` (in-browser ONNX inference)
- **YAAR Market** — install from the catalog or publish your own; the market ships source, and installs compile locally

See the [App Development Guide](./docs/guides/app-development.md).

## Trust model

YAAR lets an agent write and run code on your machine, so it is built assuming you don't trust it:

- **Scoped filesystem** — the agent sees `storage/`, `config/`, `apps/`, `session_logs/`; anything else must be mounted explicitly (read-only supported)
- **One access gate** — every route resolves *who* is calling and *what* URI + verb they want through the same check
- **App permissions** — an app touches its own namespace plus whatever its `app.json` declares; installs prompt for the rest
- **Origin isolation** — apps run on a different browser origin than the desktop, so they can't forge desktop requests or reach its DOM
- **Agent tiers** — the dangerous namespaces (`yaar://session/*`, including real-browser control) are reachable only by the privileged session agent
- **Network allowlist + SSRF guard** — outbound HTTP is limited to approved domains; internal addresses are blocked

Full detail, including what the sandbox does *not* cover: [Security](./docs/faq.md#the-ai-writes-and-runs-code-why-would-i-trust-that) and the [OS Architecture Map](./docs/architecture/os_architecture.md).

## Also

- **Multiple desktops** — each monitor has its own agent and history; a session agent coordinates across them. Sessions survive a closed tab; rejoin with `?sessionId=X`.
- **Remote access** — `make claude` / `make codex` print a QR code; connect from your phone over [Tailscale Serve](https://tailscale.com). [Guide](./docs/guides/remote_mode.md)
- **Hooks** — event-driven automation in `config/hooks.json`. [Guide](./docs/guides/hooks.md)

```
Browser (UI) ←→ Local Server ←→ Claude Code / Codex
```

Development setup and architecture: [CLAUDE.md](./CLAUDE.md).

---

_YAAR: **Y**ou **A**re **A**bsolutely **R**ight — the phrase every heavy agent user has read a few hundred times. If the agent is going to say it anyway, it may as well run the desktop._
