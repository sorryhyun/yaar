# Frontend Package

React + Zustand frontend that renders the YAAR desktop. Bundled with Bun's built-in bundler (no Vite).

## Commands

```bash
bun run build            # Build for production
bun run test             # Run tests once
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
│   └── iframe-bridge/     # Decomposed App Protocol relay (see App Protocol section)
├── styles/                # CSS Modules (organized by component subdirectory)
└── types/                 # WindowModel, DesktopState, RenderingFeedback
```

## State Management

**Zustand + Immer** pattern:
- Store split into slices under `store/slices/` (windows, monitors, agents, cli, notifications, toasts, dialogs, connection, settings, etc.)
- Composed in `store/desktop.ts`
- AI actions processed via `applyAction()` reducer — this is the core of how OS Actions become UI state; logs a warning for unhandled action types
- `applyWindowAction()` in `store/slices/windowsSlice.ts` takes the narrower `WindowAction` type and uses an exhaustive `never` guard — all window action variants must be handled
- User interactions (focus, close, move, resize) logged and sent to server
- Selectors: `selectWindowsInOrder`, `selectVisibleWindows`, `selectToasts`, etc. — grep `store/slices/` for the full list

## CLI Panel

`Shift+Tab` toggles `cliMode` (`store/slices/cliSlice.ts`), rendering `CliPanel` — a tmux-style grid of `TerminalPane`s streaming each monitor's agent. The panel also carries a **Monitor / Session ("act as me")** target toggle (`cliTarget` in the cli slice): `'session'` routes typed messages to the session agent — the user's deputy that can drive the real browser via `yaar://session/browser`. `sendMessage` (in `useAgentConnection`) attaches `target: 'session'` to `USER_MESSAGE` only while the CLI panel is open and the toggle is set; the main command palette always stays on the monitor agent.

## WebSocket Connection

`useAgentConnection` hook — singleton WebSocket with auto-reconnect (exponential backoff). Reconnects with `?sessionId=X` (rejoin) and `?token=X` (remote auth).
- Decomposed into `hooks/use-agent-connection/`: `transport-manager`, `server-event-dispatcher`, `outbound-command-helpers`, `usePendingEventDrainer`, `useMonitorSync`
- `usePendingEventDrainer` drains store queues (feedback, app protocol responses, interactions) over WS
- `useMonitorSync` sends `SUBSCRIBE_MONITOR` (which monitor *this connection* is on) on active-monitor change and on viewport resize. It does **not** announce monitor creation/deletion: the monitor list is server state, so `monitorSlice` asks for changes directly (`ADD_MONITOR` / `REMOVE_MONITOR`) and applies the server's `MONITORS` answer. See `docs/architecture/monitor_and_windows_guide.md`.
- Event types defined in `@yaar/shared` — grep `events.ts` for schemas

## Content Renderers

| Renderer | Data Type | Description |
|----------|-----------|-------------|
| `markdown` | `string` | Markdown to HTML. ` ```mermaid ` fences hydrate into diagrams — `lib/markdown.ts` emits a placeholder, `lib/mermaid.ts` draws it from a lazily-imported 3.3 MB chunk |
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

Bidirectional agent-to-iframe communication. Frontend relays between server (WebSocket) and iframe apps (postMessage). Apps register via `export default defineApp({...})` from `@bundled/yaar`, which calls the injected script's private `__registerApp` entry. Key files: `store/iframe-bridge/app-protocol-relay.ts` (`handleAppProtocolRequest()`), `usePendingEventDrainer.ts`, `IframeRenderer.tsx` (injects the underlying SDK scripts).
- Decomposed into `store/iframe-bridge/`: `target.ts` (shared DOM/iframe lookup + target-origin resolution — key resolution is deliberately not universal, since some callers address the DOM by raw window id and some by monitor-scoped key), `capture.ts`, `app-protocol-relay.ts`, `subscription-relay.ts`, `app-events.ts`, `windows-sdk.ts`, `notifications.ts`, `store-access.ts` (the only module importing `desktop.ts`, containing the runtime-only circular import)

## Testing

Bun test + Testing Library + happy-dom. Store tests use `useDesktopStore.getState()` directly. Reset store in `beforeEach` for isolation.
