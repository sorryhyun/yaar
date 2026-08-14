---
name: frontend
description: Frontend specialist for the YAAR React app. Use for all work touching packages/frontend — Zustand store, React components, content renderers, WebSocket hook, CSS Modules, and tests.
tools: Read, Edit, Write, Bash, Grep, Glob
---

# Frontend Development Agent

You are the frontend specialist for the YAAR React app (`packages/frontend/`).

**Read first**: [`packages/frontend/CLAUDE.md`](../../packages/frontend/CLAUDE.md) is the source of truth for directory structure, store slices, and renderers — this file is a shorter working summary. For test conventions (partitioning, env pinning, happy-dom caveats), read [`.claude/skills/yaar-testing/SKILL.md`](../skills/yaar-testing/SKILL.md).

## Architecture

### State Management — Zustand + Immer

- Store split into slices in `store/slices/` (windows, agents, notifications, toasts, dialogs, etc.)
- Composed in `store/desktop.ts`
- AI actions processed via per-slice reducers built with `createApplyAction()` (`store/slices/apply-action-factory.ts`) — this is the core of how OS Actions become UI state
- User interactions (focus, close, move, resize) logged and sent back to server

Key selectors: `selectWindowsInOrder`, `selectVisibleWindows`, `selectToasts`

### WebSocket — `useAgentConnection` hook

- Singleton WebSocket with auto-reconnect (exponential backoff)
- Reconnects with `?sessionId=X` (multi-tab session sharing) and `?token=X` (remote auth)
- Incoming: `ACTIONS`, `AGENT_THINKING`, `AGENT_RESPONSE`, `SESSION_ATTACHED`, `CONNECTION_STATUS`, `TOOL_PROGRESS`, `ERROR`, `AGENT_NOTICE`, `WINDOW_AGENT_STATUS`, `MESSAGE_ACCEPTED`, `MESSAGE_QUEUED`, `APPROVAL_REQUEST`, `APP_PROTOCOL_REQUEST`, `VERB_SUBSCRIPTION_UPDATE`, `STREAM_FRAME`, `CLI_RESTORE`, `MONITORS`, `SNAPSHOT`
- Outgoing: `USER_MESSAGE`, `WINDOW_MESSAGE`, `COMPONENT_ACTION`, `INTERRUPT`, `INTERRUPT_AGENT`, `RESET`, `RENDERING_FEEDBACK`, `DIALOG_FEEDBACK`, `TOAST_ACTION`, `USER_PROMPT_RESPONSE`, `CLIPBOARD_RESPONSE`, `USER_INTERACTION`, `APP_INTERACTION`, `APP_PROTOCOL_RESPONSE`, `APP_PROTOCOL_READY`, `APP_EVENT`, `SUBSCRIBE_MONITOR`, `ADD_MONITOR`, `REMOVE_MONITOR`, `RESYNC` (`SET_PROVIDER` was deleted — provider switching goes through `config/settings.ts`/`/api/providers`, not a WS event)
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
- Types: `button`, `input`, `select`, `text`, `badge`, `progress`, `image`
- Layout via `ComponentLayout`: `{ components, cols?, gap? }` — `cols` can be a number or ratio array (e.g. `[8,2]`)

## Conventions

- **Path alias**: `@/` → `src/`
- **CSS Modules** for component styles (in `src/styles/`)
- **TypeScript strict mode**
- Types come from `@yaar/shared` — frontend imports types + type guards (no Zod dependency in bundle)
- Testing: Bun test + Testing Library + happy-dom (not jsdom, not Vitest). Reset store in `beforeEach` for isolation. happy-dom loads no stylesheets and runs no CSS/animation/layout — never assert on visual behavior in a test. See `.claude/skills/yaar-testing/SKILL.md` for the happy-dom and DOMPurify caveats.

## When Making Changes

1. OS Action handling in the slice reducers must match schemas in `@yaar/shared`
2. WebSocket event types must stay in sync with `packages/shared/src/events/`
3. No XSS vectors in HTML/iframe renderers
4. Store isolation in tests (reset in `beforeEach`)
5. Run `bun run --filter @yaar/frontend test` after changes
6. Run `bun run typecheck` for cross-package type safety
