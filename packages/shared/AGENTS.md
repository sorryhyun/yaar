# Shared Package

Shared types between frontend and server.

## Exports

- `actions.ts` - OS Actions DSL
- `events.ts` - WebSocket event types
- `components.ts` - Rich UI component definitions

## OS Actions

The language AI uses to control the desktop.

**Window Actions:**
- `window.create` - Create window with bounds, content, title, preset
- `window.close`, `window.focus`, `window.minimize`, `window.maximize`, `window.restore`
- `window.move`, `window.resize`, `window.setTitle`, `window.setContent`
- `window.lock`, `window.unlock` - Prevent concurrent modifications
- `window.updateContent` - Diff-based updates (append, prepend, replace, insertAt, clear)

**Notifications:**
- `notification.show`, `notification.dismiss`

**Window Presets:** `default`, `info`, `alert`, `document`, `sidebar`, `dialog`

**Content Renderers:** `markdown`, `table`, `html`, `text`, `iframe`, `component`

## WebSocket Events

**Client → Server:**
- `USER_MESSAGE` - User input with interaction history
- `WINDOW_MESSAGE` - Message from specific window
- `INTERRUPT`, `INTERRUPT_AGENT` - Stop agents
- `SET_PROVIDER` - Switch AI provider
- `RENDERING_FEEDBACK` - Window content rendering status
- `COMPONENT_ACTION` - Interactive component action

**Server → Client:**
- `ACTIONS` - Array of OS Actions
- `AGENT_THINKING`, `AGENT_RESPONSE` - AI output stream
- `CONNECTION_STATUS` - connected/disconnected/error
- `TOOL_PROGRESS` - Tool execution status
- `WINDOW_AGENT_STATUS` - Window agent lifecycle
- `MESSAGE_ACCEPTED`, `MESSAGE_QUEUED` - Queue notifications

## Component DSL

Interactive components for `component` renderer:
- Layout: `card`, `stack`, `grid`
- Input: `button` (with action message)
- Display: `text`, `list`, `image`, `markdown`, `badge`, `progress`, `alert`, `divider`, `spacer`

## Adding a New OS Action

1. Define action type in `src/actions.ts`
2. Handle in `applyAction()` in `@claudeos/frontend`
3. Add MCP tool in `@claudeos/server` if needed
