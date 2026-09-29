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
│   ├── desktop/           # DesktopSurface, WindowManager, DesktopIcons, DesktopStatusBar, AgentStatus, PhoneGestures, PhoneTextSelection
│   ├── drawing/           # DrawingOverlay
│   ├── command-palette/   # CommandPalette (primary user input)
│   ├── taskbar/           # Taskbar (always-visible navigation)
│   ├── overlays/          # Floating/transient layers (dialogs, toasts, panels, etc.)
│   └── window/            # WindowFrame, ContentRenderer, LockOverlay, SnapPreview, SelectionActionInput
│       └── renderers/     # Markdown, Table, Html, Iframe, Component, Text renderers
├── constants/             # Layout constants, appearance tokens
├── contexts/              # ComponentActionContext, FormContext, WindowCallbackContext
├── hooks/
│   ├── use-agent-connection/  # The three connection hooks only (see WebSocket section)
│   ├── useDismissable.ts      # Escape / press-outside for every shell surface (see Dialogs)
│   ├── useDragWindow.ts, useResizeWindow.ts, useWindowDrop.ts
│   ├── useMouseTracking.ts    # owns a shell drag's document listeners AND the
│   │                          # `yaar-dragging` class, incl. release on unmount
├── i18n/                  # i18next setup, locale JSON files
├── lib/                   # Utility modules (api, exportContent, iframeMessageRouter, snapZones, uploadImage, gestures, …)
│   └── transport/         # The WebSocket and everything React-free around it (see WebSocket section)
├── store/                 # Zustand store with Immer, split into slices/; selectors.ts
│   └── iframe-bridge/     # Decomposed App Protocol relay (see App Protocol section)
├── styles/                # CSS Modules, mirroring components/ — see "Styles" below
└── types/                 # WindowModel, RenderingFeedback (each slice's own types live in its slice file)
```

## State Management

**Zustand + Immer** pattern:
- Store split into slices under `store/slices/` (windows, monitors, agents, cli, notifications, toasts, dialogs, connection, settings, etc.)
- Composed in `store/desktop.ts`
- Each slice declares its `XSliceState` / `XSliceActions` / `XSlice` **in its own file**, beside the implementation. `store/types.ts` holds only the `DesktopStore` intersection and `SliceCreator` — add a field to a slice without touching it
- Per-slice action reducers are built with `createApplyAction()` (`store/slices/apply-action-factory.ts`)
- Server actions that reach outside the store and answer the socket themselves live under `store/`: `iframe-bridge/capture.ts` (`window.capture`) and `store/clipboard.ts` (`user.clipboard.*`), both dispatched from `asyncActionRunner`
- AI actions processed via `applyAction()` (one action) and `applyActions()` (a server batch, one Immer transaction → one re-render). Both route through the **same two tables** in `store/desktop.ts`: `applySyncAction(state, action)` is the only routing table, and `asyncActionRunner(action)` returns a thunk for the actions that reach outside the store (`window.capture`, `user.clipboard.*`, `desktop.updateSettings`) and so must not run inside an Immer recipe. It is both predicate and work — `applyActions` partitions with it *without running*, holding the thunks until the recipe closes, so there is no second list of type strings. The unhandled-type warning exists once
- `applyWindowAction()` in `store/slices/windowsSlice.ts` takes the narrower `WindowAction` type and uses an exhaustive `never` guard — all window action variants must be handled
- User interactions (focus, close, move, resize) logged and sent to server
- Selectors: `selectWindowsInOrder`, `selectVisibleWindows`, `selectToasts`, etc. — `store/selectors.ts`

## Form Factor (phone layout)

`lib/formFactor.ts` picks `formFactor` (`'mobile' | 'desktop'`, ui slice) by media query — coarse pointer + narrow viewport, never UA — and `?ui=mobile|desktop|auto` pins/unpins it. `useFormFactorSync` mirrors it to `<html data-form-factor>`, which CSS Modules branch on via `:global(html[data-form-factor='mobile'])`. On mobile a standard window renders as a full-screen *card* (`data-card`, no drag/resize) sized above the command palette via the `--palette-h` var the palette publishes.

A card's full-screen title-bar button sets `fullscreenWindowId` (ui slice): the card covers the palette (pull-up handle included) and drops its own title bar and the status badge, so Back (`stepBack`) or a sideways swipe off the monitor is the way out. `selectFullscreenCardId` honours it only while that card is focused, so closing, minimizing or covering the card brings the palette back. `orientation` (ui slice, also synced by `useFormFactorSync`) comes from `screen.orientation` via `lib/device.ts`, tracked apart from the form factor because a rotation rarely crosses the media query.

The server gets form factor, orientation and viewport through `SUBSCRIBE_MONITOR` — the viewport is `settledViewport()`, the keyboard-down size — and tells the monitor agent with a `<device>` block each turn. Apps get the same two facts from `yaar.device` (`iframe-scripts/device-sdk.ts`), answered and pushed by `iframe-bridge/device.ts`, plus a per-frame `fullscreen` (is *this* app's card the full-screen one). `yaar.device.setFullscreen(on)` lands in `requestAppFullscreen` (ui slice): leaving is always granted; entering only for the top card, and never for one the user took out of full screen (`fullscreenDeclinedId`, set by `toggleFullscreenWindow`) until the orientation changes.

To try any of this on a PC: `make claude-dev-mobile` (phone-shaped Chrome with mouse drags emulated as touch; see the `MOBILE` entry in the root `CLAUDE.md`).

### Phone gestures

Recognised by `lib/gestures.ts` (pure arithmetic: `swipeDirection`, `dragAxis`, `peekOffset`, `shouldCommitDrag`, `shouldRaisePalette`, `shadeDim`, `shadeOverpull`, `stepMonitorIndex`) and wired by `components/desktop/PhoneGestures.tsx`.

| Gesture | Effect | How the touch is caught |
|---|---|---|
| Pull **up** from the bottom handle | Raises the command palette (`paletteSheetOpen`, ui slice) and opens the keyboard. The collapsed sheet follows the finger and the lift decides (see below) | The handle is shell DOM at the bottom edge — `CommandPalette` owns this one |
| Pull **up**, from anywhere nothing scrolls | The same, from further up (the bottom edge is also the system's navigation gesture). All three catchers (handle, document, frame) go through `lib/palette-sheet.ts`: `trackPaletteRaise` while the finger is down, `finishPaletteRaise` on the lift, `cancelPaletteRaise` on a cancel. Refused over a full-screen card | `document` listeners (`canRaiseFrom` — a scroller with anything left below keeps the drag), plus the frame script for an app card (`touchPan` with `axis: 'y'` and a negative `dy`, sent only when every scroller in the app is at its bottom) |
| **Drag sideways** | Pans along the strip: the previous / next monitor, the **CLI** off the left end, or a **new monitor** off the right end while the session has room (`MAX_MONITORS`; clamped — no wrap) | `document` listeners — over a window too, as long as nothing under the finger wants that drag — plus 20px gutters at `--z-gesture` at each side edge, because a touch inside an app card's iframe reaches no listener here. A gutter touch that was a tap is replayed to the element underneath |
| Pull **down**, from anywhere nothing scrolls | Brings the status/notification shade down with the finger (`notificationShadeOpen`, ui slice) | `document` listeners, plus the same frame script for an app card (`touchPan` with `axis: 'y'`, sent only when every scroller in the app is at its top) |
| Pull **down again**, on the open shade | Stretches the sheet with a "pull / release to clear context" hint; let go past `SHADE_CLEAR_PX` *while still pulling down* (`shadeClearArmed` — retreating more than `SHADE_CLEAR_RETREAT_PX` cancels) and the active monitor's context is reset (`resetActiveMonitorContext`, same as the desktop palette's button); the sheet holds on "Context cleared" (`data-shade-clear='cleared'`) for `SHADE_CLEAR_HOLD_MS` (300ms), then springs back and closes | `document` listeners, only for a touch on `[data-shade-surface]` (the sheet and its backdrop); phase in `data-shade-clear` on `<html>`, stretch in `--shade-overpull` |

**The strip.** The right end is a **new monitor**: the pan names it with `predictNextMonitorLabel` (a copy of the server's `mint()` — lowest free id), lands by calling `createMonitor`, and holds the slide (`awaitNewMonitor`) until the server's `MONITORS` answer switches the tab, or `NEW_MONITOR_WAIT_MS` passes. While any pan is under way a large **number badge** (`data-peek-badge`) stays centred naming the destination. The left end: `cliMode` sits one step **left of the first monitor** (a phone has no `Shift+Tab`). `PanTarget` in `PhoneGestures` is the monitor / `new` / `cli` / `desktop` union a pan lands on, and a landing calls `setCliMode` (cli slice), not a toggle. Entering, the peek panel paints the terminal's background; leaving, the desktop is genuinely behind `CliPanel`, so `CliPanel.module.css` translates the panel by `--monitor-peek-x` and `DesktopSurface.module.css` keeps the desktop under it visible. `CliPanel` shows one pane on a phone (the active monitor).

A desktop walks the same strip from the keyboard: **Shift+←/→** steps monitors and makes a new one off the right end (`monitorStepDirection` / `resolveMonitorStep` in `lib/shellShortcuts.ts`), without the CLI end. It is *not* a reserved combo (Shift+Arrow is text selection): `DesktopSurface` listens bubble-phase on `window` and acts only on a keystroke nobody `preventDefault()`ed and that is not in a field with text in it (`editableHoldsText` — an empty field is fair game), and the contextmenu frame script forwards one out of an app only after the whole dispatch has let it go by.

**The monitor pan** follows the finger: `PhoneGestures` writes `--monitor-peek-x` (and `--monitor-peek-ms`) onto every `data-gesture-layer="monitor-peek"` element through `lib/gesture-layer.ts`, with a `data-monitor-peek` state of `dragging` or `settling` on `<html>`. `.desktop` in `DesktopSurface.module.css` translates by it, and the peek panel in `PhoneGestures.module.css` (the neighbouring monitor's wallpaper, label and open window titles), parked one screen off the side it comes in from, translates by the same amount. The var is written straight to the DOM node, never through React — a pan re-renders only when its destination changes. **Never write a per-frame var on `<html>`**: a custom property inherits, so each write restyles the whole document (measured by `make mobile-bench`). The vars are registered `inherits: false` with `@property` and written onto the elements that read them; an element that mounts mid-gesture takes `gestureLayerRef(layer)` to catch up.

**The shade pull** works the same way through `lib/shade-pull.ts`: `--shade-pull` (how much of the sheet is on screen) and `--shade-dim` (backdrop darkness), written onto the sheet and its backdrop as the `shade-pull` gesture layer, with a `data-shade-pull` state of `dragging` / `settling` / `open` on `<html>`; `NotificationShade.module.css` turns it into `translateY(min(0px, calc(-100% + var(--shade-pull))))`, so neither end needs the sheet's height. `PhoneGestures` owns the pull-down (the shade mounts on the first frame of the drag; a pull let go too early settles back and closes it), and the shade's own grip owns the push-up. `canPullFrom` is `panBlockFrom` one axis over: it refuses only a drag that would otherwise be a scroll still available (a scroller already at its top gives the drag to the shade). The pull `preventDefault`s a downward move *before* `dragAxis` has decided, because Chrome starts scrolling on the first move it is allowed to keep.

**Axis and blocking.** `dragAxis` locks the axis at 10px (far sooner than `swipeDirection`'s 56px, biased towards vertical so an ambiguous drag stays a scroll), and the pan may begin anywhere, **including over a window**. `panBlockFrom` answers **per direction**: a sideways scroller blocks the way it can still scroll and hands back the way it cannot, so the direction the pan set off in (locked with the axis, in `Drag.panning`) decides. `data-no-pan` (the palette, the drawing canvas) and a slider (`role="slider"` or `input[type=range]`) are outright refusals. `shouldCommitDrag` decides the landing on distance *or* flick speed — the same rule for the shade pull; anything else settles back.

**The palette sheet.** On a phone the palette is a **bottom sheet**, collapsed to a labelled handle by default: translated down by its own height less the handle, with `--palette-h` published from the handle's height (not a mid-transition rect). The sheet body is `inert` while collapsed. Raised, it has a dimming backdrop (`data-palette-backdrop`) whose tap closes the sheet without pressing the card underneath. The shade and the palette sheet are mutually exclusive.

**The palette pull** mirrors the shade: the collapsed sheet follows the finger through `--palette-pull` (the `palette-pull` gesture layer), with `data-palette-pull="dragging"` on `<html>` — and **the store is not touched until the finger lifts** (setting `paletteSheetOpen` mid-drag let the focus effect raise the keyboard on a small nudge). On the lift `shouldRaisePalette` decides — `PALETTE_RAISE_PX` (80px, above `SWIPE_MIN_PX`) or a flick of at least `PALETTE_FLICK_MIN_PX` — and the container's own CSS transition opens it or lets it fall back (no settle timer). A flick coalesced into start and end alone still opens on `swipeDirection`. A phone opens the keyboard only for a `focus()` a user gesture is still activating, so `openPaletteSheetWithKeyboard` focuses from inside the touchend/click handler — clearing `inert` on the node first (React has not re-rendered yet), and *before* the pull phase is cleared (focus() flushes style). The effect keyed on `sheetOpen` stays as the fallback for every other way the sheet opens.

### Phone shade, palette, Back, selection

**Notifications** render in `NotificationShade` on a phone and in `NotificationCenter` on a desktop; the auto-dismiss timers stay in `NotificationCenter` either way. The pull-down is the only way into the shade.

The shade is the phone's **status surface**: `DesktopStatusBar` renders nothing on a phone; the connection reading is shown inside the shade, with **Stop All** at the right end of that row while any agent is working. The per-agent roster is desktop-only (the corner `PhoneStatusBadge` counts working agents). `components/desktop/AgentStatus.tsx` holds `ConnectionStatus` and `AgentRoster` for both surfaces. The shade does not close itself when the last notification goes; a disconnection is reported there and nowhere else.

It is the phone's **navigation surface** too: `MonitorTabs` (the monitor switcher and its "+") and `Taskbar` (window tabs) render inside the shade — `CommandPalette` gates both behind `!isMobile`. A tap in either row leaves the sheet open; it closes by the grip or the backdrop. A monitor chip there uses `shortLabel` (drops the "Monitor " prefix; full label in `title`) at `--text-lg` in a 44px target. The row is shown even with **one** monitor (the desktop hides it). The "+" sits against the last chip (`margin-left: auto` undone). The chip carries **no ×**: the phone **flicks the chip up** to close a monitor — `MonitorTabs` recognises that itself (`dragAxis` / `shouldCommitDrag`, `touch-action: pan-x` so the row keeps its sideways scroll, transform written straight to the chip). `DEFAULT_MONITOR_ID` has no handlers (the server refuses to delete it); since `removeMonitor` is a *request*, a thrown chip that no `MONITORS` answer unmounts is put back after `LIFT_RESTORE_MS`. The phone-only rules at the foot of `styles/taskbar/Taskbar.module.css` are all about that row.

On a phone the **context reset is not in the palette**: the pen takes the reset's slot, and pulling the open shade down again is the reset (see Phone gestures). `components/command-palette/ContextResetButton.tsx` is the desktop palette's button; both call `resetActiveMonitorContext`. The palette's icon cluster steps aside while the textarea is focused, except the pen.

The phone's **Back button** puts away one layer per press instead of leaving YAAR. `hooks/usePhoneBack.ts` keeps a *guard* history entry (`{ yaarBackGuard: true }`) on top; Back pops it, `popstate` runs `stepBack` (`lib/phoneBack.ts`), and the guard goes back on. Order, top first: the `useDismissable` Escape stack (dialogs, the shade — `dismissTopSurface`), the palette sheet, a full-screen card, the CLI, then the top card, which is **minimized, never closed** (closing retires its app agent). On a bare desktop the guard stays off and a toast says "press back again to exit"; it is re-armed after `EXIT_HINT_MS`. Chrome skips on Back an entry pushed without a user touch, so before the first tap Back still leaves. An app iframe that navigates adds its own joint-history entries, which Back walks first.

**Text selection** is the shell's own on a phone (Chrome's selection toolbar cannot be changed from a page): window content is `user-select: none` (fields keep native selection for the IME) and `components/desktop/PhoneTextSelection.tsx` selects instead. Holding still for `LONG_PRESS_MS` on a word selects it (`caretPositionFromPoint` → `Intl.Segmenter` in `lib/textSelection.ts`), painted with the CSS Custom Highlight API (`::highlight(yaar-selection)`) rather than the document `Selection`. Two **handles** drag either end (`dragHandle`: crossing the anchor swaps them; near the top or bottom of the scroller it auto-scrolls); the menu offers Copy (`lib/copyText.ts`, with an `execCommand` fallback for plain-http remote mode), Select all, and Ask AI (the same `SelectionActionInput` a desktop right-click opens). The long-press **claims the touch** (`claimTouch`) and `PhoneGestures` drops a claimed touch; a handle claims on touchstart. A tap elsewhere, `beginShellDrag`, and any pan or pull under way (`data-monitor-peek` / `data-shade-pull` / `data-palette-pull` on `<html>`) clear it; a scroll moves handles and menu with it. **App cards** get the same through `iframe-scripts/text-selection.ts` (`@yaar/shared`, injected and baked in): the frame does the long-press, holds the `Range`, and reports it (`APP_MSG.textSelection`, frame coordinates, plus the scroller box as `clip`); the shell holds it as a `kind: 'frame'` selection, draws the same handles and menu, and sends back `APP_MSG.textSelectionCommand` (`clear`, `selectAll`, `dragStart`/`drag`/`dragEnd`). Copy runs in the shell with the text the frame sent. The frame's claim is `window.__yaarTouchClaimed`, which the contextmenu script's pan relay checks. Handles are hidden with `visibility`, never unmounted, when their end leaves the clip — a detached touch target loses the rest of the touch.

## CLI Panel

`Shift+Tab` toggles `cliMode` (`store/slices/cliSlice.ts`) — on a phone it is the left end of the sideways pan — rendering `CliPanel`, a tmux-style grid of `TerminalPane`s streaming each monitor's agent. A phone gets **one** pane, and numbered **monitor buttons** in a top bar (`.topBar`, `display: contents` on a desktop; a real padded row on a phone). The panel also carries a **Monitor / Session ("act as me")** target toggle (`cliTarget` in the cli slice): `'session'` routes typed messages to the session agent — the user's deputy that can drive the real browser via `yaar://session/browser`. `sendMessage` (in `lib/transport/commands.ts`) attaches `target: 'session'` to `USER_MESSAGE` only while the CLI panel is open and the toggle is set; the main command palette always stays on the monitor agent.

## WebSocket Connection

One singleton WebSocket with auto-reconnect (exponential backoff), reconnecting with `?sessionId=X` (rejoin) and `?token=X` (remote auth).

**There is one socket, so there is one owner.** `useAgentConnectionOwner()` (in `hooks/useAgentConnection.ts`) is mounted **exactly once**, by `DesktopSurface`, and is the only thing that calls `connect()` or mounts `useClientPresence` / `usePendingEventDrainer` / `useMonitorSync`. Everything else — `sendMessage`, `reset`, `sendDialogFeedback`, `retryConnection`, … — is a **plain module function** imported from the same file; only `useIsConnected()` is a hook, subscribing to the transport alone. **Do not add a second mount point**: the sub-hooks install global listeners against the singleton, so a second mount doubles the frames (`CLIENT_PRESENCE`, `RESYNC` and its authoritative `SNAPSHOT`, `SUBSCRIBE_MONITOR`).
- The React-free half lives in `lib/transport/` (imported by `store/` and `lib/` as well as hooks, so not under `hooks/`): `connection` (socket lifecycle — `connect`/`disconnect`/`retryConnection`/`recoverAfterResume`, the liveness probe, the inbound handler), `commands` (every outbound frame), `transport-manager`, `server-event-dispatcher`, `outbound-command-helpers`, `liveness-probe`, `pending-queues` (`drainPendingQueues`), `frames` (`monitorSubscription`, `clientPresence` — frames the reconnect path sends on the hooks' behalf). `hooks/use-agent-connection/` keeps only the three real hooks: `usePendingEventDrainer`, `useMonitorSync`, `useClientPresence`
- `usePendingEventDrainer` drains store queues (feedback, app protocol responses, interactions) over WS
- `useMonitorSync` sends `SUBSCRIBE_MONITOR` (which monitor *this connection* is on, its viewport, and its `formFactor`) on connect, active-monitor change, form-factor change, and viewport resize — always built by `monitorSubscription()`. It does **not** announce monitor creation/deletion: the monitor list is server state, so `monitorSlice` sends `ADD_MONITOR` / `REMOVE_MONITOR` and applies the server's `MONITORS` answer. See `docs/architecture/monitor_and_windows_guide.md`.
- `useClientPresence` sends `CLIENT_PRESENCE` (`visible` / `hidden` / `frozen`) on `visibilitychange` and the Page Lifecycle `freeze`/`resume` events, and re-announces on every (re)connect. **An open socket is not a live desktop**: a backgrounded tab keeps its WebSocket while running no script, so every server→client wait against it would time out. The server records presence per connection (`session/client-presence.ts`) and appends the reason to those timeouts; it changes no other behavior.
- Coming back is its own recovery trigger: the same hook re-runs `flushPending()` + `RESYNC` when a frozen tab becomes visible again, or after being hidden longer than `RESYNC_AFTER_HIDDEN_MS`; short flicks away skip it. `freeze`/`resume` listeners belong on `document`; a resume while still hidden reports `hidden` and defers recovery until visibility returns. Recovery does **not** reload apps: `applySnapshot` keeps the iframe token of a window already on screen (the token rides in the frame's `src`). After a changed session incarnation, `setAttachment` marks held tokens stale and `applySnapshot` adopts the fresh tokens from the server snapshot; the flag survives reconnects until that snapshot lands. There is no grace timer or per-window HTTP refresh.
- **That recovery is then checked** by `liveness-probe.ts`: a resumed phone often holds a socket whose peer is gone while `readyState` still reads `OPEN` and no `onclose` fires. The resume path's `RESYNC` owes a `SNAPSHOT`, so it arms a deadline (`LIVENESS_PROBE_TIMEOUT_MS`, 8s); any inbound frame disarms it. Silence past the deadline calls `replaceDeadSocket()`, which drops the reference and connects again immediately without waiting on `close()` (`openSocket`'s `isCurrent()` guard makes that safe). A socket stuck in `CONNECTING` gets the same deadline.
- `reset()` is a **delivery, not a gesture**: it carries a `messageId`, goes into the outbox beside user messages, and is resent on the next attach until the server acks it (`MESSAGE_ACCEPTED` with `agentId: NO_AGENT_ACK`, which settles the outbox without filing a status chip). The local clear still happens on the spot.
- Event types defined in `@yaar/shared` — grep `events/client.ts` and `events/server.ts` for schemas

## Service Worker

`public/sw.js`, registered from `main.tsx` via `lib/registerServiceWorker.ts` after the first render. It caches the **shell** so an installed YAAR opens like an app after a phone discards the tab. It is **not** background execution — nothing here talks to the agent.

Three request kinds; everything else gets no `respondWith`: the desktop document (`destination === 'document'`) is network-first with a 2.5s deadline then the cached shell (bundle filenames are content-hashed into the HTML); content-hashed build output is cache-first and never revalidated; fixed-name `public/` assets (webfonts, icons, manifest) are stale-while-revalidate. `/api/*` is never cached, and app iframe documents (`destination === 'iframe'`) fall through even when an app shares this origin.

It needs a **secure context**, so on `http://192.168.x.x:8000` registration returns quietly; remote mode over Tailscale Serve and `localhost` get it. `?nosw` on the URL unregisters it and empties its caches.

## Dialogs

Every blocking dialog renders inside `components/overlays/Modal.tsx`, and every surface that Escape or a press outside should put away uses `hooks/useDismissable.ts`. Escape goes to the **most recently opened** surface only (a module-level stack). `Modal` adds `role="dialog"` + `aria-modal`, keeps Tab inside, and hands focus back on close. It focuses the **backdrop**, not the first button, when nothing inside claimed focus — dialogs are agent-raised, and a pending Enter must not land on Cancel. Escape on `ConfirmDialog` is Cancel *once* — never a remembered deny, even with the box ticked — and on `UserPrompt` it is Skip, or nothing when the prompt allows no skip. `ConnectionDialog` takes no `onDismiss`. `CommandPalette`'s outside-press listener for its expanded textarea stays hand-rolled (paired with a window-`blur` signal). The phone sheet uses its backdrop instead of a listener.

## Styles

`styles/` mirrors `components/` (`components/overlays/Foo.tsx` → `styles/overlays/Foo.module.css`) instead of sitting beside it, so **deleting a component does not put its stylesheet in front of you** — `tests/design/orphan-styles.test.ts` fails on any module nothing imports. File names are only half-true (`DesktopSurface.module.css` is imported by four components, `AgentStatus` among them; the `WindowFrame`, `Taskbar` and `CliPanel` modules serve two each) — grep for importers before assuming ownership.

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
3. Update the renderer enums: server `handlers/window.ts` (`create` schema) and `@yaar/shared`'s `displayRendererSchema` (`components.ts`)

## App Protocol

Bidirectional agent-to-iframe communication. Frontend relays between server (WebSocket) and iframe apps (postMessage). Apps register via `export default defineApp({...})` from `@bundled/yaar`, which calls the injected script's private `__registerApp` entry. Key files: `store/iframe-bridge/app-protocol-relay.ts` (`handleAppProtocolRequest()`), `usePendingEventDrainer.ts`, `IframeRenderer.tsx` (injects the underlying SDK scripts).
- Decomposed into `store/iframe-bridge/`: `target.ts` (shared DOM/iframe lookup + target-origin resolution — key resolution is deliberately not universal, since some callers address the DOM by raw window id and some by monitor-scoped key), `capture.ts`, `app-protocol-relay.ts`, `subscription-relay.ts`, `app-events.ts`, `open-url.ts` (where a link out of an app lands — asks `GET /api/embeddable` first, so a site that refuses framing goes to the Browser app), `windows-sdk.ts`, `notifications.ts`, `device.ts`, `drop.ts` (file drops onto a window, frame or app content), `host-download.ts` (`yaar:download` saved through the native host), `store-access.ts` (the only module importing `desktop.ts`, containing the runtime-only circular import)

## Testing

Bun test + Testing Library + happy-dom. Store tests use `useDesktopStore.getState()` directly. Reset store in `beforeEach` for isolation.

The package's `test` script passes **`--isolate`**, and component tests that `mock.module('@/hooks/useAgentConnection')` (`ConfirmDialog`, `UserPrompt`, the two `CommandPalette` files) depend on it — without it their stubs leak into later files (`reset-delivery.test.tsx`). Rationale: the `yaar-testing` skill.
