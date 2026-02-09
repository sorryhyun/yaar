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

The AI doesn't just respond with text — it **creates the UI**. Ask for a task list, and a window appears with checkboxes. Ask to compare data, and a table renders. The interface adapts to your intent.

```
You: "Show me today's tasks"
 AI: Creates window with interactive task list
You: "Compare these two files"
 AI: Creates side-by-side diff view
```

### 2. Draw and Send

`Alt + Left-click drag` anywhere on screen to sketch. Draw a wireframe, diagram, or quick note — send it to the AI and it interprets your drawing to generate code, explain concepts, or refine the design.

### 3. Reload (Fast Response)

When window content needs to be refreshed, cached content is restored instantly without re-querying the AI. A fingerprint-based cache ensures identical content is displayed immediately without additional AI calls.

### 4. Dynamic Context Injection

Context is injected based on what you're doing:
- Click an app icon → AI loads the app's `SKILL.md` instructions
- Interact with a window → AI receives the interaction context
- Reference previous results → AI has conversation history

The AI always knows what's relevant without you having to explain.

### 5. App Development

Say "make me a Tetris game" and the AI writes TypeScript, compiles it with esbuild, and deploys it to your desktop. Bundled libraries (lodash, anime.js, Konva, etc.) are available without npm install, and code runs in an isolated sandbox.

For API-driven apps, describe the API in a `SKILL.md` file and the AI handles the rest.

See the [App Development Guide](./docs/app-development.md#english) for details.

## Session, Monitor, and Window

YAAR's runtime is organized into three nested abstractions.

```
Session
├── Monitor 0 ("Desktop 1")
│   ├── Main Agent (sequential, overflows to ephemeral agents when busy)
│   ├── Window A ─── Window Agent (parallel)
│   ├── Window B ─── Window Agent (parallel)
│   └── CLI history
├── Monitor 1 ("Desktop 2")
│   ├── Main Agent (independent, same overflow model)
│   ├── Window C ─── Window Agent (parallel)
│   └── CLI history
└── Event log (messages.jsonl)
```

### Session — Persistence Beyond Connections

A **session** is the top-level container for an entire conversation. It owns all state — agents, windows, context history. Sessions survive browser tab closures; reconnect with `?sessionId=X` to restore the previous state. Multiple tabs can share the same session.

### Monitor — Independent Parallel Workspaces

A **monitor** is a virtual desktop within a session (up to 4). Each monitor has its own main agent and message queue, operating completely independently. Run a long task on Monitor 1 while continuing work on Monitor 0. Switch with `Ctrl+1`–`Ctrl+9`.

When the main agent is busy and a new message arrives, an **ephemeral agent** is spawned to handle it in parallel. Ephemeral agents are automatically disposed after completing their task.

### Window — AI-Created Interactive UI

A **window** is a UI surface created by the AI via OS Actions. Each window can have a dedicated **window agent** that runs **in parallel** with the main agent and other window agents. Only requests to the same window are serialized.

### Parallelism Summary

| Scope | Execution | Description |
|-------|-----------|-------------|
| Across monitors | **Parallel** | Each monitor's main agent runs independently |
| Monitor main queue | **Sequential + overflow** | Sequential by default; ephemeral agents handle overflow in parallel |
| Window agents | **Parallel** | Agents for different windows run concurrently |
| Within a window | **Sequential** | Tasks for one window are serialized |

See [`docs/monitor_and_windows_guide.md`](./docs/monitor_and_windows_guide.md) for details.

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
