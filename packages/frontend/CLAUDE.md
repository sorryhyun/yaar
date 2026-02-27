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
│   ├── desktop/           # DesktopSurface, WindowManager, DesktopIcons, DesktopStatusBar
│   ├── drawing/           # DrawingOverlay
│   ├── command-palette/   # CommandPalette (primary user input)
│   ├── taskbar/           # Taskbar (always-visible navigation)
│   ├── overlays/          # Floating/transient layers (dialogs, toasts, panels, etc.)
│   └── window/            # WindowFrame, ContentRenderer, LockOverlay, SnapPreview, SelectionActionInput
│       └── renderers/     # Markdown, Table, Html, Iframe, Component, Text renderers
├── constants/             # Layout constants, appearance tokens
├── contexts/              # ComponentActionContext, FormContext, WindowCallbackContext
├── hooks/
│   ├── use-agent-connection/  # Decomposed WebSocket logic (transport, dispatcher, event drainer, monitor sync)
│   ├── useAgentConnection.ts  # Re-export entry point
│   ├── useDragWindow.ts
│   ├── useResizeWindow.ts
│   └── useWindowDrop.ts
├── i18n/                  # i18next setup, locale JSON files (en, de, es, fr, ja, ko, pt, zh)
├── lib/                   # Utility modules (api, exportContent, iframeMessageRouter, snapZones, uploadImage)
├── store/                 # Zustand store with Immer, split into slices/
├── styles/                # CSS Modules (organized by component subdirectory)
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
- `cliSlice` — per-monitor CLI history with streaming support
- `connectionSlice` — WebSocket status, sessionId, provider
- `agentsSlice` — agent state tracking (thinking, active agents, window agents, subagent counts)
- `notificationsSlice` — persistent notification center
- `toastsSlice` — temporary toast messages
- `dialogsSlice` — modal confirmation dialogs
- `userPromptsSlice` — ask/request prompt dialogs
- `settingsSlice` — user settings (userName, language, wallpaper, accentColor, iconSize; persisted to localStorage)
- `drawingSlice` — Ctrl+Drag drawing overlay state
- `imageAttachSlice` — image attachment for messages
- `feedbackSlice` — rendering feedback and app protocol response queues
- `interactionsSlice` — pending user interactions and gesture messages queue
- `queuedActionsSlice` — component actions queued while a window is locked
- `debugSlice` — activity log, debug log (raw WS events), debug/recent-actions panel state
- `uiSlice` — context menu, sessions modal, settings modal, restore prompt, selected window IDs

**Key selectors:**
- `selectWindowsInOrder` — windows sorted by z-order
- `selectVisibleWindows` — non-minimized standard windows on the active monitor (stable insertion order, memoized)
- `selectMinimizedWindows` — minimized standard windows on the active monitor
- `selectMinimizedIframeWindows` — minimized iframe windows on the active monitor
- `selectWidgetWindows` — widget-variant windows on the active monitor (memoized)
- `selectPanelWindows` — panel-variant windows on the active monitor (memoized)
- `selectToasts` — active toasts
- `selectNotifications` — all notifications
- `selectDialogs` — all open dialogs
- `selectUserPrompts` — all open user prompts
- `selectActiveAgents` — all active agents
- `selectWindowAgents` — window-agent map
- `selectWindowAgent(windowId)` — selector factory for a specific window's agent
- `selectQueuedActionsCount(windowId)` — selector factory for queued action count

## WebSocket Connection

`useAgentConnection` hook manages:
- Singleton WebSocket with auto-reconnect (exponential backoff)
- Reconnects with `?sessionId=X` to rejoin existing sessions; `?token=X` for remote auth
- Decomposed into `hooks/use-agent-connection/`: `transport-manager`, `server-event-dispatcher`, `outbound-command-helpers`, `usePendingEventDrainer`, `useMonitorSync`
- Incoming events handled: `ACTIONS`, `AGENT_THINKING`, `AGENT_RESPONSE`, `TOOL_PROGRESS`, `APP_PROTOCOL_REQUEST`, `APPROVAL_REQUEST`, `WINDOW_AGENT_STATUS`, `CONNECTION_STATUS`, `ERROR`
- Incoming events not yet dispatched to store: `MESSAGE_ACCEPTED`, `MESSAGE_QUEUED`
- Outgoing: `USER_MESSAGE`, `WINDOW_MESSAGE`, `COMPONENT_ACTION`, `INTERRUPT`, `INTERRUPT_AGENT`, `RESET`, `SET_PROVIDER`, `APP_PROTOCOL_RESPONSE`, `APP_PROTOCOL_READY`, `DIALOG_FEEDBACK`, `TOAST_ACTION`, `USER_PROMPT_RESPONSE`, `USER_INTERACTION`, `RENDERING_FEEDBACK`, `SUBSCRIBE_MONITOR`, `REMOVE_MONITOR`
- `usePendingEventDrainer` — drains store queues (feedback, app protocol responses, app interactions, interactions, gesture messages, queued component actions) over WebSocket
- `useMonitorSync` — sends `SUBSCRIBE_MONITOR` / `REMOVE_MONITOR` when active monitor changes

## Content Renderers

| Renderer | Data Type | Description |
|----------|-----------|-------------|
| `markdown` | `string` | Markdown to HTML |
| `table` | `{headers, rows}` | Table rendering |
| `html` | `string` | Raw HTML |
| `text` | `string` | Plain text |
| `iframe` | `string \| { url, sandbox? }` | Embedded iframe (injects multiple scripts: `IFRAME_APP_PROTOCOL_SCRIPT`, `IFRAME_CAPTURE_HELPER_SCRIPT`, `IFRAME_STORAGE_SDK_SCRIPT`, `IFRAME_FETCH_PROXY_SCRIPT`, `IFRAME_CONTEXTMENU_SCRIPT`, `IFRAME_NOTIFICATIONS_SDK_SCRIPT`) |
| `component` | `ComponentNode` | Interactive React components from JSON |

## Adding a New Content Renderer

1. Create `src/components/window/renderers/<Name>Renderer.tsx`
2. Add case in `src/components/window/ContentRenderer.tsx`
3. Add styles in `src/styles/window/renderers.module.css`
4. Update renderer enum in `@yaar/server` tools

## App Protocol

Bidirectional agent-to-iframe communication. The frontend acts as a relay between server (WebSocket) and iframe apps (postMessage).

- `store/desktop.ts` — `handleAppProtocolRequest()` forwards server requests to the target iframe via postMessage, collects responses.
- `hooks/use-agent-connection/usePendingEventDrainer.ts` — Drains `pendingAppProtocolResponses` and `pendingAppProtocolReady` from the store and sends `APP_PROTOCOL_RESPONSE` and `APP_PROTOCOL_READY` events to the server.
- `components/window/renderers/IframeRenderer.tsx` — Injects multiple SDK scripts (including `IFRAME_APP_PROTOCOL_SCRIPT`) into iframe `<head>` to provide `window.yaar.app.register()` and related APIs.

## Testing

Uses Vitest + Testing Library + jsdom:
- Store tests: direct access via `useDesktopStore.getState()`
- Reset store in `beforeEach` for isolation
