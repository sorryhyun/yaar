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
