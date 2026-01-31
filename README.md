# ClaudeOS

A **reactive AI interface** where the AI decides what to show and do next based on your input.

Instead of pre-built screens with fixed layouts and navigation menus, you get an **always-ready input field** at the center. The AI **creates the UI dynamically** — windows, tables, forms, and visualizations appear as needed. The interface adapts to your intent, not the other way around.

## How It Works

```
You type something
       ↓
AI interprets your intent
       ↓
AI emits "OS Actions" (JSON commands)
       ↓
Frontend renders windows and content
       ↓
You interact or ask for more
       ↓
Repeat
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Frontend                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │
│  │   Input     │  │   Windows   │  │  Notifications  │ │
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
│                   Server (TypeScript)                   │
│  ┌──────▼──────┐  ┌──────┴──────┐                      │
│  │   Session   │  │   Action    │                      │
│  │   Handler   │──▶  Parser     │                      │
│  └──────┬──────┘  └─────────────┘                      │
│         │                                               │
│  ┌──────▼──────────────────────────────────────────┐   │
│  │           Claude Agent SDK Transport            │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**The AI never touches React state directly.** It only emits OS Actions — a small JSON DSL. The frontend applies these through a reducer. Everything is logged and replayable.

## Quick Start

**Prerequisites:**
- Node.js >= 24
- pnpm >= 10
- Claude CLI installed and authenticated (`npm install -g @anthropic-ai/claude-code && claude login`)

```bash
pnpm install    # Install dependencies
make claude     # Start with Claude provider
make codex      # Start with Codex provider
make dev        # Start with auto-detected provider
```

`sudo apt-get install poppler-data poppler-utils`

Open http://localhost:5173 to see ClaudeOS.

## OS Actions DSL

The AI controls the UI through a simple action vocabulary:

| Action | What it does |
|--------|-------------|
| `window.create` | Opens a new window with content |
| `window.updateContent` | Updates what's in a window |
| `window.close` | Closes a window |
| `window.focus` | Brings a window to front |
| `notification.show` | Shows a persistent notification |

## Content Renderers

Windows can display different types of content:

- **markdown** - Rich text, documentation, explanations
- **table** - Structured data with headers and rows
- **text** - Plain text, logs, code output
- **html** - Custom interactive elements

## The Vision

Imagine asking:

> "Show me today's tasks and let me mark them complete"

And the AI:
1. Creates a window with a task list
2. Each task has a checkbox
3. Checking a box updates the task

All without writing a todo app. The AI generates the interface on demand.

## Why "ClaudeOS"?

It's an "operating system" in the sense that it:
- Manages windows and focus
- Handles notifications
- Provides a consistent environment
- Mediates between user intent and displayed content

But the AI is the "kernel" — it decides what runs, what shows, and how things connect.

## Project Structure

```
claudeos/
├── apps/              # Convention-based apps (each folder = one app)
│   └── moltbook/      # Example: Moltbook social network integration
├── packages/
│   ├── shared/        # Shared types (OS Actions, WebSocket events)
│   ├── server/        # TypeScript WebSocket server
│   └── frontend/      # React frontend
```

See [CLAUDE.md](./CLAUDE.md) for detailed development instructions.

## Apps System

ClaudeOS supports **convention-based apps**. Each folder in `apps/` automatically becomes a desktop icon.

### How It Works

```
User clicks app icon (e.g., "Moltbook")
       ↓
Frontend sends "user clicked app: moltbook"
       ↓
AI loads apps/moltbook/SKILL.md
       ↓
AI uses skill instructions to help user
       ↓
(Register, post, browse feed, etc.)
```

### Creating an App

1. Create a folder: `apps/myapp/`
2. Add `SKILL.md` with instructions for the AI:
   - What the app does
   - API endpoints and authentication
   - Example workflows

```markdown
# MyApp

Description of what this app does.

## Authentication
How to authenticate with the API.

## API Endpoints
Available endpoints and how to use them.

## Example Workflows
Step-by-step guides for common tasks.
```

3. Credentials are stored in `credentials.json` (git-ignored for security)

## Future Directions

- More content renderers (charts, code editor, forms)
- More app integrations
- Multi-window workspaces
