# Frontend Package

React + Zustand + Vite frontend that renders the YAAR desktop.

## Commands

```bash
bun run dev              # Start dev server (proxies /ws and /api to localhost:8000)
bun run build            # Build for production
bun run vitest run       # Run tests once (add --watch for watch mode)
```

## Code Style

- TypeScript strict, path alias `@/` → `src/`, CSS Modules for styles

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
│   ├── use-agent-connection/  # Decomposed WebSocket logic (see WebSocket section)
│   ├── useDragWindow.ts, useResizeWindow.ts, useWindowDrop.ts
├── i18n/                  # i18next setup, locale JSON files
├── lib/                   # Utility modules (api, exportContent, iframeMessageRouter, snapZones, uploadImage)
├── store/                 # Zustand store with Immer, split into slices/
├── styles/                # CSS Modules (organized by component subdirectory)
└── types/                 # WindowModel, DesktopState, RenderingFeedback
```

## State Management

**Zustand + Immer** pattern:
- Store split into slices under `store/slices/` (windows, monitors, agents, cli, notifications, toasts, dialogs, connection, settings, etc.)
- Composed in `store/desktop.ts`
- AI actions processed via `applyAction()` reducer — this is the core of how OS Actions become UI state
- User interactions (focus, close, move, resize) logged and sent to server
- Selectors: `selectWindowsInOrder`, `selectVisibleWindows`, `selectToasts`, etc. — grep `store/slices/` for the full list

## WebSocket Connection

`useAgentConnection` hook — singleton WebSocket with auto-reconnect (exponential backoff). Reconnects with `?sessionId=X` (rejoin) and `?token=X` (remote auth).
- Decomposed into `hooks/use-agent-connection/`: `transport-manager`, `server-event-dispatcher`, `outbound-command-helpers`, `usePendingEventDrainer`, `useMonitorSync`
- `usePendingEventDrainer` drains store queues (feedback, app protocol responses, interactions) over WS
- `useMonitorSync` sends `SUBSCRIBE_MONITOR` / `REMOVE_MONITOR` on active monitor change
- Event types defined in `@yaar/shared` — grep `events.ts` for schemas

## Content Renderers

| Renderer | Data Type | Description |
|----------|-----------|-------------|
| `markdown` | `string` | Markdown to HTML |
| `table` | `{headers, rows}` | Table rendering |
| `html` | `string` | Raw HTML |
| `text` | `string` | Plain text |
| `iframe` | `string \| { url, sandbox? }` | Embedded iframe (injects SDK scripts for app protocol, storage, fetch proxy, etc.) |
| `component` | `ComponentNode` | Interactive React components from JSON |

## Adding a New Content Renderer

1. Create `src/components/window/renderers/<Name>Renderer.tsx`
2. Add case in `ContentRenderer.tsx`, add styles in `styles/window/renderers.module.css`
3. Update renderer enum in `@yaar/server` tools

## App Protocol

Bidirectional agent-to-iframe communication. Frontend relays between server (WebSocket) and iframe apps (postMessage). Apps import `{ app } from '@bundled/yaar'` and call `app.register()`. Key files: `store/desktop.ts` (`handleAppProtocolRequest()`), `usePendingEventDrainer.ts`, `IframeRenderer.tsx` (injects the underlying SDK scripts).

## Testing

Vitest + Testing Library + jsdom. Store tests use `useDesktopStore.getState()` directly. Reset store in `beforeEach` for isolation.
