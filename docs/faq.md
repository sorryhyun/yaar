# FAQ — Why Is YAAR Like This?

> [한국어 버전](./ko/faq.md)

Questions people actually ask when they first see the project, with honest answers. If you want the mechanics instead, start with the [OS Architecture Map](./architecture/os_architecture.md) and the [Monitor & Windows guide](./architecture/monitor_and_windows_guide.md).

---

### What is this, in one sentence?

A desktop where the AI is the one deciding what appears on screen: you type into a single always-ready input, and the agent responds by opening windows, building apps, and wiring them together — instead of writing you a paragraph.

---

### Why a GUI? Agent tools are all TUIs / chat boxes.

Because text streams serialize everything, and agent work isn't serial.

A chat transcript can only show you one thing at a time, in the order it happened. But an agent session naturally produces *state*: a chart that should stay visible while you ask the next question, a file browser you want to keep open, three background tasks running on different virtual desktops. Windows are the honest representation of that — persistent, parallel, individually addressable.

The GUI is also an *input* surface, not just output. You can paste an image, sketch with right-click drag, click a button inside an AI-built window, or drag a file onto an app. Every one of those is a message to the agent that would be awkward or impossible to express in a terminal.

And practically: LLMs are genuinely good at producing HTML/JS UI. "Respond with a working interface" is a capability sitting right there — chat interfaces just don't give the model anywhere to put it.

(There is still a TUI-ish escape hatch: `Shift+Tab` opens a CLI panel that streams the agent's raw reasoning and tool calls, for when you want to watch the machinery.)

---### Why build a whole "OS" for what is basically agent orchestration?

Because agent orchestration, done honestly, keeps re-inventing OS problems — so YAAR just borrows the OS answers instead of inventing worse ones ad hoc:

| Orchestration problem | OS answer YAAR reuses |
|---|---|
| Many agents, bounded resources | Process table + scheduler (`AgentPool`, queue policies, rate budgets) |
| Agents shouldn't trample each other | Process isolation + a privileged tier (session agent ≈ root, app agents sandboxed) |
| Agents need to act on the world | Syscalls (MCP tools) instead of arbitrary access |
| Agents need to talk to each other | IPC (app protocol, relay, direct messages) |
| Capabilities should be installable | Package manager (apps are folders; the Market installs them) |
| Work should survive a disconnect | Sessions persist independently of the browser tab |

The OS framing isn't branding — it's a design vocabulary with fifty years of proven answers to exactly the questions multi-agent systems hit: scheduling, permissions, addressing, lifecycle. See the [OS Architecture Map](./architecture/os_architecture.md) for the full concept-by-concept mapping.

To be clear about scope: YAAR is not trying to replace your operating system. It's a local server plus a browser tab. The "OS" is a shape, not a boot partition.

---

### Why web / HTML? Why not a native app?

Three reasons, in decreasing order of importance:

1. **Single-file HTML is the best sandboxable UI runtime we have.** Every YAAR app compiles to one self-contained HTML file rendered in an iframe. That gives per-app boundaries, trivial distribution (an app *is* a file), and hot-swappable windows — with no plugin ABI, no native packaging per platform.
2. **It's the format the model is best at.** Asking an LLM to emit working HTML/CSS/JS plays to the strongest part of its training distribution. Asking it to emit Qt or SwiftUI does not.
3. **A browser front-end is free reach.** The same server renders on your laptop, and — via remote mode's QR code — on your phone, with zero extra client code.

The stack under it is deliberately boring: a local Bun/TypeScript server owns all state; the browser is just the display server.

---

### How does the agent actually access things? Does it have 50 tools?

Five. `describe` · `read` · `list` · `invoke` · `delete`.

Everything in the system — windows, files, apps, config, notifications, other agents — is addressable as a `yaar://` URI, and those five verbs operate on any of them:

```
list('yaar://apps')                          → what's installed
describe('yaar://apps/slides-lite')          → its schema and supported verbs
read('yaar://storage/data.csv')              → file contents
invoke('yaar://windows/chart', {...})        → open/update a window
delete('yaar://windows/old-panel')           → close it
```

The point is context economy. A conventional MCP setup registers one tool per capability, so the tool list — and the system prompt — grows with every app you install. YAAR's system prompt stays under ~8K tokens whether you have 3 apps or 100, because capability discovery happens at runtime (`describe`) instead of at prompt-assembly time. Full reference: [URI-based resource addressing](./architecture/verbalized-with-uri.md).

---

### The AI writes and runs code. Why would I trust that?

You shouldn't have to trust it — the design assumes you don't:

- **Scoped filesystem.** The AI's file access is confined to `storage/`, `config/`, `apps/`, and `session_logs/` by default. Outside folders must be explicitly mounted (read-only supported).
- **One access gate.** Every HTTP route resolves *who is calling* (desktop vs. app principal) and *what URI + verb* they want, through the same check. Routes don't invent their own permission logic.
- **App permission scopes.** An app touches its own storage (`yaar://apps/self/storage/`) plus whatever `app.json` declares — nothing else.
- **Network allowlist + SSRF guard.** Outbound HTTP is limited to domains in `config/curl_allowed_domains.yaml`; new domains require your approval; internal-network addresses are blocked.
- **Agent tiers.** The dangerous namespaces (`yaar://session/*`, including real-browser control) are reachable only by the privileged session agent. Everything else is default-deny.
- **Origin isolation.** Apps are served from a different browser origin than the desktop, so an app can't forge desktop-level requests.

Known honest limitation: app iframes are not yet fully sandboxed, so a *malicious installed app* can still reach the desktop DOM via `window.parent`. Don't install apps you don't trust. Current boundaries and remaining work are tracked in [known gaps](./architecture/known_gaps.md).

---

### Why are apps just folders?

Because in most AI tooling, one capability is scattered across four registries: a skill file for the AI, a plugin for the server, a UI component for the frontend, a config somewhere else. In YAAR one folder carries all of it:

```
apps/slides-lite/
  app.json        ← metadata + permissions
  SKILL.md        ← what the AI reads to know how to use it
  AGENTS.md       ← optional: a dedicated agent for this app
  src/main.ts     ← the UI + logic
  dist/index.html ← the build: one self-contained file
```

Drop the folder in → installed. Delete it → gone. No registration code. It also means an app can bundle its own agent: interact with an app window and a persistent app agent spins up for it, able to message the monitor agent — or, with declared `controls`, drive *other* apps directly (Dev Tools drives the Browser app to build and test apps end-to-end).

---

### Which AI is behind it? Am I paying another subscription?

YAAR is a front-end to an agent runtime you already have: it drives **Claude Code** (via the Agent SDK) or **Codex** (via JSON-RPC) as a subprocess, using your existing login. There's no separate YAAR account, API key, or hosted service — the server runs on your machine, and your conversations go wherever your chosen provider already sends them, nowhere else. Provider behavioral differences are documented in [claude_codex.md](./reference/claude_codex.md).

---

### Isn't this just chat-with-artifacts, or a computer-use agent?

Close neighbors, different premise:

- **Chat + artifacts** bolts UI output onto a conversation. In YAAR the relationship is inverted: the desktop is the primary medium and the conversation is the input method. Windows persist, are addressable (`yaar://windows/...`), can be messaged individually, and survive across sessions.
- **Computer-use agents** point an AI at a screen built for humans and make it fumble with pixels and clicks. YAAR gives the AI an environment built for *it* — everything is a URI with a schema, so acting on the system is a typed call, not screenshot archaeology. (When actual browsing is needed, there's a gated `yaar-web` SDK for that.)

---

### Why "YAAR"?

**Y**ou **A**re **A**bsolutely **R**ight — the phrase every heavy agent user has read a few hundred times. If the AI is going to say it anyway, it may as well run the desktop.
