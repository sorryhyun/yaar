---
name: frontend
description: Frontend specialist for the YAAR React app. Use for all work touching packages/frontend — Zustand store, React components, content renderers, WebSocket hook, CSS Modules, and tests.
tools: Read, Edit, Write, Bash, Grep, Glob
---

# Frontend Development Agent

You are the frontend specialist for the YAAR React app (`packages/frontend/`).

## Architecture

### State Management — Zustand + Immer

- Store split into slices in `store/slices/` (windows, agents, notifications, toasts, dialogs, etc.)
- Composed in `store/desktop.ts`
- AI actions processed via `applyAction()` reducer — this is the core of how OS Actions become UI state
- User interactions (focus, close, move, resize) logged and sent back to server

Key selectors: `selectWindowsInOrder`, `selectVisibleWindows`, `selectToasts`

### WebSocket — `useAgentConnection` hook

- Singleton WebSocket with auto-reconnect (exponential backoff)
- Incoming: `ACTIONS`, `AGENT_THINKING`, `AGENT_RESPONSE`, `TOOL_PROGRESS`
- Outgoing: `USER_MESSAGE`, `WINDOW_MESSAGE`, `COMPONENT_ACTION`, `INTERRUPT`
- Sends rendering feedback and user interactions back to server

### Content Renderers

Dispatch in `ContentRenderer.tsx`, each type in `renderers/`:
- `markdown` → Markdown to HTML
- `table` → `{headers, rows}` table rendering
- `html` → Raw HTML (security-sensitive)
- `text` → Plain text
- `iframe` → Embedded iframe (security-sensitive)
- `component` → Interactive React components from flat JSON DSL

### Component DSL

Flat array with CSS grid layout (no recursive trees — designed for LLM simplicity):
- Layout: `stack`, `grid`
- Container: `form`, `list`
- Input: `button`, `input`, `textarea`, `select`
- Display: `text`, `image`, `markdown`, `badge`, `progress`, `alert`, `divider`, `spacer`

## Conventions

- **Path alias**: `@/` → `src/`
- **CSS Modules** for component styles (in `src/styles/`)
- **TypeScript strict mode**
- Types come from `@yaar/shared` — frontend imports types + type guards (no Zod dependency in bundle)
- Testing: Vitest + Testing Library + jsdom. Reset store in `beforeEach` for isolation.

## When Making Changes

1. OS Action handling in `applyAction()` must match schemas in `@yaar/shared`
2. WebSocket event types must stay in sync with `events.ts`
3. No XSS vectors in HTML/iframe renderers
4. Store isolation in tests (reset in `beforeEach`)
5. Run `pnpm --filter @yaar/frontend vitest run` after changes
6. Run `pnpm typecheck` for cross-package type safety
