# What is ClaudeOS?

## The Core Idea

ClaudeOS is a **reactive AI interface** where the AI decides what to show and do next based on your input.

Instead of:
- Pre-built screens with fixed layouts
- Navigation menus you click through
- Apps you launch manually

You get:
- An **always-ready input field** at the center
- The AI **creates the UI dynamically** based on what you ask
- Windows, tables, forms, and visualizations appear as needed
- The interface **adapts to your intent**, not the other way around

## How It Works

```
You type something
       ↓
AI interprets your intent
       ↓
AI emits "OS Actions" (JSON commands)
       ↓
Frontend renders windows, toasts, content
       ↓
You interact or ask for more
       ↓
Repeat
```

## The Always-Ready Input

The input field is the primary interface. It's always visible, always focused, always ready.

- Ask a question → AI opens a window with the answer
- Request data → AI creates a table view
- Want to compare things → AI opens multiple windows side by side
- Need a form → AI generates it dynamically

The AI doesn't just answer - it **decides the best way to present** the answer.

## OS Actions DSL

The AI controls the UI through a simple action vocabulary:

| Action | What it does |
|--------|-------------|
| `window.create` | Opens a new window with content |
| `window.setContent` | Updates what's in a window |
| `window.close` | Closes a window |
| `window.focus` | Brings a window to front |
| `toast.show` | Shows a brief notification |
| `notification.show` | Shows a persistent alert |

## Content Renderers

Windows can display different types of content:

- **markdown** - Rich text, documentation, explanations
- **table** - Structured data with headers and rows
- **text** - Plain text, logs, code output
- **html** - (Future) Custom interactive elements

## What This Is NOT

- Not a chat interface where AI just replies with text
- Not a traditional desktop OS emulator
- Not a collection of pre-built apps
- Not dependent on any specific LLM provider (supports Claude Code, Codex)

## The Vision

Imagine asking:

> "Show me today's tasks and let me mark them complete"

And the AI:
1. Creates a window with a task list
2. Each task has a checkbox
3. Checking a box updates the task
4. A toast confirms "Task completed"

All without writing a todo app. The AI **generates the interface on demand**.

## Technical Foundation

- **Frontend**: React + Zustand for state, CSS modules for styling
- **Backend**: FastAPI with WebSocket for real-time communication
- **Providers**: Abstraction layer supporting Claude Code CLI and Codex CLI
- **Protocol**: JSON events over WebSocket, actions validated against schema

## Why "ClaudeOS"?

It's an "operating system" in the sense that it:
- Manages windows and focus
- Handles notifications
- Provides a consistent environment
- Mediates between user intent and displayed content

But the AI is the "kernel" - it decides what runs, what shows, and how things connect.
