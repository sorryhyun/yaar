# ClaudeOS — Project Direction

> For the core concept, see **[what.md](./what.md)**

## Vision

A reactive AI interface where you type, and the AI decides what to show.

No menus. No app launchers. Just an **always-ready input field** and an AI that creates the UI dynamically based on what you need.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Frontend                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │
│  │   Input     │  │   Windows   │  │  Toasts/Notifs  │ │
│  │   Field     │  │   Manager   │  │                 │ │
│  └──────┬──────┘  └──────▲──────┘  └────────▲────────┘ │
│         │                │                   │          │
│         │         ┌──────┴───────────────────┘          │
│         │         │  Zustand Store                      │
│         │         │  (applies OS Actions)               │
│         │         └──────▲──────────────────────────────┤
│         │                │                              │
└─────────┼────────────────┼──────────────────────────────┘
          │                │
          │ WebSocket      │ OS Actions (JSON)
          │                │
┌─────────▼────────────────┼──────────────────────────────┐
│         │                │         Backend              │
│  ┌──────▼──────┐  ┌──────┴──────┐                      │
│  │   Session   │  │   Action    │                      │
│  │   Handler   │──▶  Parser     │                      │
│  └──────┬──────┘  └─────────────┘                      │
│         │                                               │
│  ┌──────▼──────────────────────────────────────────┐   │
│  │              AI Provider                         │   │
│  │  ┌─────────────┐       ┌─────────────┐          │   │
│  │  │   Claude    │       │    Codex    │          │   │
│  │  │    CLI      │       │     CLI     │          │   │
│  │  └─────────────┘       └─────────────┘          │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## Core Principle

**The AI never touches React state directly.**

It only emits **OS Actions** — a small JSON DSL:

```json
{"type": "window.create", "windowId": "w1", "title": "Results", ...}
{"type": "toast.show", "id": "t1", "message": "Done!", "variant": "success"}
```

The frontend applies these through a reducer. Everything is logged and replayable.

---

## Supported Providers

| Provider | Protocol | Session |
|----------|----------|---------|
| **Claude Code CLI** | Line-delimited JSON | `--resume` flag |
| **Codex CLI** | JSON-RPC 2.0 | `session/resume` RPC |

Both extract OS Actions the same way: finding JSON blocks in the AI's response text.

---

## Implementation Steps

| Step | Focus | Status |
|------|-------|--------|
| 1 | Project setup, directory structure | ✅ Done |
| 2 | Provider base interfaces | ✅ Done |
| 3 | Platform support (bundled binaries for Windows) | ✅ Done |
| 4 | Provider factory | ✅ Done |
| 5 | Claude provider | ✅ Done |
| 6 | Codex provider | ✅ Done |
| 7 | Frontend state (Zustand) | ✅ Done |
| 8 | Frontend components (windows, toasts) | ✅ Done |
| 9 | WebSocket connection | ✅ Done |
| 10 | Integration & testing | ✅ Done |

### Running the Project

```bash
# Backend
uv sync
uv run uvicorn backend.main:app --reload

# Frontend (in separate terminal)
cd frontend && npm install && npm run dev

# Or use the combined dev script
./scripts/dev.sh
```

Open http://localhost:5173 to see ClaudeOS.

**Note:** Requires Claude CLI (`npm install -g @anthropic-ai/claude-code`) for the agent to function.

---

## Future Directions

### Near-term
- More content renderers (charts, code editor, forms)
- Keyboard shortcuts
- Session persistence

### Mid-term
- Tool system (web search, file ops)
- MCP server integration
- Permission/approval dialogs for risky actions

### Long-term
- Agent-created "macro tools" (workflows composed of existing tools)
- Multi-window workspaces
- Collaborative sessions

---

## Non-Goals

- Traditional desktop OS emulation
- Pre-built apps with fixed UIs
- Custom/third-party LLM provider support (for now)
