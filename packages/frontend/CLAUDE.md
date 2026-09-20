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
│   ├── desktop/           # DesktopSurface, WindowManager, DesktopIcons, DesktopStatusBar, AgentStatus
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

## Form Factor (phone layout)

`lib/formFactor.ts` picks `formFactor` (`'mobile' | 'desktop'`, ui slice) by media query — coarse pointer + narrow viewport, never UA — and `?ui=mobile|desktop|auto` pins/unpins it. `useFormFactorSync` mirrors it to `<html data-form-factor>`, which CSS Modules branch on via `:global(html[data-form-factor='mobile'])`. On mobile a standard window renders as a full-screen *card* (`data-card`, no drag/resize) sized above the command palette via the `--palette-h` var the palette publishes. A card's ⤢ title-bar button is the phone's maximize: it sets `fullscreenWindowId` (ui slice) and the card covers the palette (monitor/window tabs included) too; `selectFullscreenCardId` honours it only while that card is focused, so closing, minimizing or covering the card brings the palette back. The server gets the form factor through `SUBSCRIBE_MONITOR` and tells the monitor agent with a `<device>` block each turn.

### Phone gestures

Three of them, recognised by `lib/gestures.ts` (pure arithmetic: `swipeDirection`, `dragAxis`, `peekOffset`, `shouldCommitDrag`, `shadeDim`, `edgeZone`, `stepMonitorIndex`) and wired by `components/desktop/PhoneGestures.tsx`.

| Gesture | Effect | How the touch is caught |
|---|---|---|
| Pull **up** from the bottom handle | Raises the command palette (`paletteSheetOpen`, ui slice) and opens the keyboard | The handle is shell DOM at the bottom edge — `CommandPalette` owns this one |
| **Drag sideways** | Pans along the strip: the previous / next monitor, or the **CLI** off the left end of it (clamped — no wrap) | `document` listeners, plus 20px gutters at `--z-gesture` at each side edge for the case the shell does not own: an app card is an iframe, so a touch inside one reaches no listener here. A gutter touch that was a tap is replayed to the element underneath |
| Pull **down** from the top | Brings the status/notification shade down with the finger (`notificationShadeOpen`, ui slice) | `document` listeners — the top of the screen is a title bar or the home grid, both shell DOM, so nothing is covered and no tap is stolen |

The strip is one wider than the monitor list: `cliMode` sits one step **left of the first monitor**, because a phone has no `Shift+Tab` and the CLI was otherwise unreachable there. `PanTarget` in `PhoneGestures` is the monitor / `cli` / `desktop` union the pan lands on, and `setCliMode` (cli slice) is what a landing calls — a toggle would undo itself on the second swipe in the same direction. Entering, the peek panel paints the terminal's background instead of a wallpaper; leaving, nothing is drawn at all: the desktop is genuinely behind `CliPanel`, so `CliPanel.module.css` translates the panel by `--monitor-peek-x` and `DesktopSurface.module.css` makes the desktop under it stay put and visible for the slide to uncover. `CliPanel` shows one pane on a phone (the active monitor) — a tmux grid on 412px is unreadable columns.

**The monitor pan** follows the finger: `PhoneGestures` publishes `--monitor-peek-x` (and `--monitor-peek-ms`) on `<html>` with a `data-monitor-peek` state of `dragging` or `settling`, and two CSS rules read them — `.desktop` in `DesktopSurface.module.css` translates by it, and the peek panel in `PhoneGestures.module.css`, parked one screen off the side it comes in from, translates by the same amount. The panel is the neighbouring monitor's wallpaper, label and open window titles. The var is written straight to the DOM node, never through React: a pan re-renders once, when the monitor it is heading for changes, not once per frame.

**The shade pull** works the same way, through `lib/shade-pull.ts`: `--shade-pull` (how much of the sheet is on screen), `--shade-dim` (how dark the desktop behind it is) and a `data-shade-pull` state of `dragging` / `settling` / `open` on `<html>`, which `NotificationShade.module.css` turns into `translateY(min(0px, calc(-100% + var(--shade-pull))))` — so neither end of the gesture has to know how tall the sheet is. It has two ends: `PhoneGestures` owns the pull-down (the shade is mounted on the first frame of the drag, and a pull that is let go too early settles back and closes it), and the shade's own grip owns the push-up. `canPullFrom` is deliberately looser than `canPanFrom` — the top band *is* a card's title bar most of the time, so a shade that refused to start over a window would have nowhere to start — and refuses only what a downward drag would otherwise have been: a scroll, and only while there is still one to be had. A scroller already at its top (a home screen with more icons than fit) has nothing left to give a downward drag, so the drag is the shade's; the pull also `preventDefault`s a downward move *before* `dragAxis` has decided, because Chrome starts scrolling on the first move it is allowed to keep and the moves stop being cancelable after that.

Because the pan is visible it no longer has to start at an edge. `dragAxis` locks the axis at 10px — far sooner than `swipeDirection`'s 56px, and biased towards vertical so an ambiguous drag stays a scroll — and the pan may begin anywhere the shell owns. Not inside a window (`data-window-id`; a card is the monitor's *content*), not on a sideways scroller, and not on a surface that opted out with `data-no-pan` (the palette, the drawing canvas). `shouldCommitDrag` decides the landing on distance *or* flick speed — the same rule for the shade pull, so a flick means the same thing on both axes; anything else settles back.

The palette is a **bottom sheet** on a phone: collapsed to a labelled handle by default, so the screen belongs to the card. Collapsed it is translated down by its own height less the handle, and `--palette-h` is published from the handle's height instead of the container's — a rect read mid-transition would hand the cards a height about to be wrong. The sheet body is `inert` while collapsed so its textarea cannot be focused off the bottom edge. The two sheets are mutually exclusive: raising one lowers the other.

To try any of this on a PC: `make claude-dev-mobile`. A narrow window is only half of a phone — the other half is touch, which a mouse does not produce — so it opens a phone-shaped Chrome on its own profile and `scripts/dev/emulate-mobile.ts` attaches over CDP to turn mouse drags into real touch streams. See the `MOBILE` entry in the root `CLAUDE.md`.

The pull-up raises the sheet on **touchmove**, as soon as the pull has said "up", so the slide and the rest of the drag overlap. The keyboard is a separate problem: a phone opens it only for a `focus()` that a user gesture is still activating, so `openSheetWithKeyboard` focuses from inside the touchend/click handler — clearing `inert` on the node first, since React has not re-rendered yet — rather than from the effect keyed on `sheetOpen`. That effect stays as the fallback for every other way the sheet can open.

Notifications render in `NotificationShade` on a phone and in `NotificationCenter` on a desktop, because a top-right stack lands on a card's title bar. The auto-dismiss timers stay in `NotificationCenter` either way, so one component owns expiry; a badge marks a shade with something in it.

The shade is the phone's **status surface** as well: `DesktopStatusBar` renders nothing at all on a phone — a pill that says "Connected" all session, dot included, is chrome a 412px screen has no room for — and the connection reading and the agent roster are shown inside the pull-down instead. `components/desktop/AgentStatus.tsx` holds the two pieces (`ConnectionStatus`, `AgentRoster`) both surfaces render, so they cannot drift. Because the shade now always has something in it, it no longer closes itself when the last notification goes; a pull-down on a quiet session used to look like a gesture that did not work. A disconnection is reported there and nowhere else.

On a phone the palette's icon cluster steps aside while the textarea is focused, with one exception: **reset stays**. It is the only way to clear the monitor's context from a phone — there is no menu bar and no keyboard shortcut — and the moment it is wanted is the moment the user is typing into a context they have decided to be rid of.

## CLI Panel

`Shift+Tab` toggles `cliMode` (`store/slices/cliSlice.ts`) — on a phone it is the left-hand end of the sideways pan instead, see Phone gestures — rendering `CliPanel` — a tmux-style grid of `TerminalPane`s streaming each monitor's agent. The panel also carries a **Monitor / Session ("act as me")** target toggle (`cliTarget` in the cli slice): `'session'` routes typed messages to the session agent — the user's deputy that can drive the real browser via `yaar://session/browser`. `sendMessage` (in `useAgentConnection`) attaches `target: 'session'` to `USER_MESSAGE` only while the CLI panel is open and the toggle is set; the main command palette always stays on the monitor agent.

## WebSocket Connection

`useAgentConnection` hook — singleton WebSocket with auto-reconnect (exponential backoff). Reconnects with `?sessionId=X` (rejoin) and `?token=X` (remote auth).
- Decomposed into `hooks/use-agent-connection/`: `transport-manager`, `server-event-dispatcher`, `outbound-command-helpers`, `usePendingEventDrainer`, `useMonitorSync`, `useClientPresence`
- `usePendingEventDrainer` drains store queues (feedback, app protocol responses, interactions) over WS
- `useMonitorSync` sends `SUBSCRIBE_MONITOR` (which monitor *this connection* is on, its viewport, and its `formFactor`) on connect, active-monitor change, form-factor change, and viewport resize — always built by `monitorSubscription()`. It does **not** announce monitor creation/deletion: the monitor list is server state, so `monitorSlice` asks for changes directly (`ADD_MONITOR` / `REMOVE_MONITOR`) and applies the server's `MONITORS` answer. See `docs/architecture/monitor_and_windows_guide.md`.
- `useClientPresence` sends `CLIENT_PRESENCE` (`visible` / `hidden` / `frozen`) on `visibilitychange` and the Page Lifecycle `freeze`/`resume` events, and re-announces on every (re)connect. **An open socket is not a live desktop**: a backgrounded tab keeps its WebSocket while running no script, so without this frame every server→client wait against it — `app_query`, window capture, the 2s render confirm — times out and reports the app as broken, across every window at once. Measured against real Chrome, a frozen tab held its socket for 264s, past the 255s transport idle timeout, because the server's own sends keep resetting the idle clock. The server records it per connection (`session/client-presence.ts`) and appends the reason to those timeouts; it changes no other behavior.
- Coming back is also its own recovery trigger, not just socket close: the same hook re-runs `flushPending()` + `RESYNC` on `resume`, or after being hidden longer than `RESYNC_AFTER_HIDDEN_MS`. Reattach was the only path before, which left a tab that froze and resumed *without* the socket dropping talking to a server that had given up on it. Short flicks away deliberately skip it — a snapshot remounts app iframes.
- Event types defined in `@yaar/shared` — grep `events/client.ts` and `events/server.ts` for schemas

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
- Decomposed into `store/iframe-bridge/`: `target.ts` (shared DOM/iframe lookup + target-origin resolution — key resolution is deliberately not universal, since some callers address the DOM by raw window id and some by monitor-scoped key), `capture.ts`, `app-protocol-relay.ts`, `subscription-relay.ts`, `app-events.ts`, `open-url.ts` (where a link out of an app lands — it asks `GET /api/embeddable` first, so a site that refuses framing goes to the Browser app instead of an iframe window that cannot paint), `windows-sdk.ts`, `notifications.ts`, `store-access.ts` (the only module importing `desktop.ts`, containing the runtime-only circular import)

## Testing

Bun test + Testing Library + happy-dom. Store tests use `useDesktopStore.getState()` directly. Reset store in `beforeEach` for isolation.
