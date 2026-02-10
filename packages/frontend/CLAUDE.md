# Frontend Package

React + Zustand + Vite frontend that renders the YAAR desktop.

## Commands

```bash
pnpm dev                    # Start dev server (proxies /ws and /api to localhost:8000)
pnpm build                  # Build for production
pnpm vitest                 # Run tests in watch mode
pnpm vitest run             # Run tests once
```

## Code Style

- TypeScript strict mode
- Path alias: `@/` → `src/`
- CSS Modules for component styles

## Directory Structure

```
src/
├── components/
│   ├── desktop/           # DesktopSurface, WindowManager
│   ├── drawing/           # DrawingOverlay
│   ├── ui/                # CommandPalette, NotificationCenter, DebugPanel, dialogs, etc.
│   └── windows/           # WindowFrame, ContentRenderer, LockOverlay
│       └── renderers/     # Markdown, Table, Html, Iframe, Component, Text renderers
├── contexts/              # ComponentActionContext, FormContext
├── hooks/                 # useAgentConnection (WebSocket singleton)
├── store/                 # Zustand store with Immer, split into slices/
├── styles/                # CSS Modules
└── types/                 # WindowModel, DesktopState, RenderingFeedback
```

## State Management

**Zustand + Immer** pattern:
- Store split into slices (`store/slices/`) — windows, monitors, agents, cli, notifications, toasts, dialogs, connection, etc.
- Composed in `store/desktop.ts`
- AI actions processed via `applyAction()` reducer
- User interactions (focus, close, move, resize) logged and sent to server

**Key slices:**
- `windowsSlice` — window CRUD, z-order, focus, bounds
- `monitorSlice` — virtual desktops (create, remove, switch). Each window belongs to a monitor via `monitorId`. See `docs/monitor_and_windows_guide.md`.
- `cliSlice` — per-monitor CLI history
- `connectionSlice` — WebSocket status, sessionId, provider

**Key selectors:**
- `selectWindowsInOrder` - Windows sorted by z-order
- `selectVisibleWindows` - Non-minimized windows **on the active monitor**
- `selectMinimizedWindows` - Minimized windows on the active monitor
- `selectToasts` - Active toasts

## WebSocket Connection

`useAgentConnection` hook manages:
- Singleton WebSocket with auto-reconnect (exponential backoff)
- Incoming events: `ACTIONS`, `AGENT_THINKING`, `AGENT_RESPONSE`, `TOOL_PROGRESS`, `APP_PROTOCOL_REQUEST`
- Outgoing: `USER_MESSAGE`, `WINDOW_MESSAGE`, `COMPONENT_ACTION`, `INTERRUPT`, `APP_PROTOCOL_RESPONSE`, `APP_PROTOCOL_READY`
- Sends rendering feedback, user interactions, and app protocol responses back to server

## Content Renderers

| Renderer | Data Type | Description |
|----------|-----------|-------------|
| `markdown` | `string` | Markdown to HTML |
| `table` | `{headers, rows}` | Table rendering |
| `html` | `string` | Raw HTML |
| `text` | `string` | Plain text |
| `iframe` | `string` (URL) | Embedded iframe (injects `IFRAME_APP_PROTOCOL_SCRIPT` for agent communication) |
| `component` | `ComponentNode` | Interactive React components from JSON |

## Adding a New Content Renderer

1. Create `src/components/windows/renderers/<Name>Renderer.tsx`
2. Add case in `src/components/windows/ContentRenderer.tsx`
3. Add styles in `src/styles/renderers.module.css`
4. Update renderer enum in `@yaar/server` tools

## App Protocol

Bidirectional agent-to-iframe communication. The frontend acts as a relay between server (WebSocket) and iframe apps (postMessage).

- `store/desktop.ts` — `handleAppProtocolRequest()` forwards server requests to the target iframe via postMessage, collects responses. `initAppProtocolReadyListener()` listens for `yaar:app-ready` from iframes and queues `APP_PROTOCOL_READY` events.
- `hooks/useAgentConnection.ts` — Subscribes to `pendingAppProtocolResponses` and `pendingAppProtocolReady` in the store, sends `APP_PROTOCOL_RESPONSE` and `APP_PROTOCOL_READY` events to the server.
- `components/windows/renderers/IframeRenderer.tsx` — Injects `IFRAME_APP_PROTOCOL_SCRIPT` into iframe `<head>` to provide `window.yaar.app.register()` SDK.

## Testing

Uses Vitest + Testing Library + jsdom:
- Store tests: direct access via `useDesktopStore.getState()`
- Reset store in `beforeEach` for isolation
