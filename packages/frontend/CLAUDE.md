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
│   ├── use-agent-connection/  # The three connection hooks only (see WebSocket section)
│   ├── useDismissable.ts      # Escape / press-outside for every shell surface (see Dialogs)
│   ├── useDragWindow.ts, useResizeWindow.ts, useWindowDrop.ts
│   ├── useMouseTracking.ts    # owns a shell drag's document listeners AND the
│   │                          # `yaar-dragging` class, incl. release on unmount
├── i18n/                  # i18next setup, locale JSON files
├── lib/                   # Utility modules (api, exportContent, iframeMessageRouter, snapZones, uploadImage)
│   └── transport/         # The WebSocket and everything React-free around it (see WebSocket section)
├── store/                 # Zustand store with Immer, split into slices/
│   └── iframe-bridge/     # Decomposed App Protocol relay (see App Protocol section)
├── styles/                # CSS Modules, mirroring components/ — see "Styles" below
└── types/                 # WindowModel, RenderingFeedback (each slice's own types live in its slice file)
```

## State Management

**Zustand + Immer** pattern:
- Store split into slices under `store/slices/` (windows, monitors, agents, cli, notifications, toasts, dialogs, connection, settings, etc.)
- Composed in `store/desktop.ts`
- Each slice declares its `XSliceState` / `XSliceActions` / `XSlice` **in its own file**, beside the implementation. `store/types.ts` holds only the `DesktopStore` intersection (cross-slice access needs the whole shape in one place) and `SliceCreator` — add a field to a slice without touching it
- Server actions that reach outside the store and answer the socket themselves live under `store/` beside each other: `iframe-bridge/capture.ts` (`window.capture`) and `store/clipboard.ts` (`user.clipboard.*`), both dispatched from `asyncActionRunner`
- AI actions processed via `applyAction()` (one action) and `applyActions()` (a server batch, one Immer transaction → one re-render). Both route through the **same two tables** in `store/desktop.ts`: `applySyncAction(state, action)` is the only routing table, and `asyncActionRunner(action)` returns a thunk for the actions that reach outside the store (`window.capture`, `user.clipboard.*`, `desktop.updateSettings`) and so must not run inside an Immer recipe. That function is both the predicate and the work, deliberately — `applyActions` partitions with it *without running*, holding the thunks until the recipe closes, so there is no second list of type strings to keep in step. There used to be two hand-written tables sixty lines apart, and they had already drifted. The unhandled-type warning exists once
- `applyWindowAction()` in `store/slices/windowsSlice.ts` takes the narrower `WindowAction` type and uses an exhaustive `never` guard — all window action variants must be handled
- User interactions (focus, close, move, resize) logged and sent to server
- Selectors: `selectWindowsInOrder`, `selectVisibleWindows`, `selectToasts`, etc. — grep `store/slices/` for the full list

## Form Factor (phone layout)

`lib/formFactor.ts` picks `formFactor` (`'mobile' | 'desktop'`, ui slice) by media query — coarse pointer + narrow viewport, never UA — and `?ui=mobile|desktop|auto` pins/unpins it. `useFormFactorSync` mirrors it to `<html data-form-factor>`, which CSS Modules branch on via `:global(html[data-form-factor='mobile'])`. On mobile a standard window renders as a full-screen *card* (`data-card`, no drag/resize) sized above the command palette via the `--palette-h` var the palette publishes. A card's full-screen title-bar button is the phone's maximize: it sets `fullscreenWindowId` (ui slice) and the card covers the palette too; `selectFullscreenCardId` honours it only while that card is focused, so closing, minimizing or covering the card brings the palette back. The server gets the form factor through `SUBSCRIBE_MONITOR` and tells the monitor agent with a `<device>` block each turn.

### Phone gestures

Three of them, recognised by `lib/gestures.ts` (pure arithmetic: `swipeDirection`, `dragAxis`, `peekOffset`, `shouldCommitDrag`, `shadeDim`, `edgeZone`, `stepMonitorIndex`) and wired by `components/desktop/PhoneGestures.tsx`.

| Gesture | Effect | How the touch is caught |
|---|---|---|
| Pull **up** from the bottom handle | Raises the command palette (`paletteSheetOpen`, ui slice) and opens the keyboard | The handle is shell DOM at the bottom edge — `CommandPalette` owns this one |
| **Drag sideways** | Pans along the strip: the previous / next monitor, or the **CLI** off the left end of it (clamped — no wrap) | `document` listeners — over a window too, as long as nothing under the finger wants that drag — plus 20px gutters at `--z-gesture` at each side edge for the case this document hears nothing about: an app card is an iframe, so a touch inside one reaches no listener here. A gutter touch that was a tap is replayed to the element underneath |
| Pull **down** from the top | Brings the status/notification shade down with the finger (`notificationShadeOpen`, ui slice) | `document` listeners — the top of the screen is a title bar or the home grid, both shell DOM, so nothing is covered and no tap is stolen |

The strip is one wider than the monitor list: `cliMode` sits one step **left of the first monitor**, because a phone has no `Shift+Tab` and the CLI was otherwise unreachable there. `PanTarget` in `PhoneGestures` is the monitor / `cli` / `desktop` union the pan lands on, and `setCliMode` (cli slice) is what a landing calls — a toggle would undo itself on the second swipe in the same direction. Entering, the peek panel paints the terminal's background instead of a wallpaper; leaving, nothing is drawn at all: the desktop is genuinely behind `CliPanel`, so `CliPanel.module.css` translates the panel by `--monitor-peek-x` and `DesktopSurface.module.css` makes the desktop under it stay put and visible for the slide to uncover. `CliPanel` shows one pane on a phone (the active monitor) — a tmux grid on 412px is unreadable columns.

**The monitor pan** follows the finger: `PhoneGestures` writes `--monitor-peek-x` (and `--monitor-peek-ms`) onto every `data-gesture-layer="monitor-peek"` element through `lib/gesture-layer.ts`, with a `data-monitor-peek` state of `dragging` or `settling` on `<html>`, and CSS rules read them — `.desktop` in `DesktopSurface.module.css` translates by it, and the peek panel in `PhoneGestures.module.css`, parked one screen off the side it comes in from, translates by the same amount. The panel is the neighbouring monitor's wallpaper, label and open window titles. The var is written straight to the DOM node, never through React: a pan re-renders once, when the monitor it is heading for changes, not once per frame. **Never write a per-frame var on `<html>`**: a custom property inherits, so each write restyles the whole document (~600ms of style recalc over four swipes at 9k nodes, measured by `make mobile-bench`). The vars are registered `inherits: false` with `@property` and written onto the elements that read them; an element that mounts mid-gesture takes `gestureLayerRef(layer)` to catch up.

**The shade pull** works the same way, through `lib/shade-pull.ts`: `--shade-pull` (how much of the sheet is on screen) and `--shade-dim` (how dark the desktop behind it is), written onto the sheet and its backdrop as the `shade-pull` gesture layer, and a `data-shade-pull` state of `dragging` / `settling` / `open` on `<html>`, which `NotificationShade.module.css` turns into `translateY(min(0px, calc(-100% + var(--shade-pull))))` — so neither end of the gesture has to know how tall the sheet is. It has two ends: `PhoneGestures` owns the pull-down (the shade is mounted on the first frame of the drag, and a pull that is let go too early settles back and closes it), and the shade's own grip owns the push-up. `canPullFrom` is `panBlockFrom` one axis over — the top band *is* a card's title bar most of the time, so a shade that refused to start over a window would have nowhere to start — and refuses only what a downward drag would otherwise have been: a scroll, and only while there is still one to be had. A scroller already at its top (a home screen with more icons than fit) has nothing left to give a downward drag, so the drag is the shade's; the pull also `preventDefault`s a downward move *before* `dragAxis` has decided, because Chrome starts scrolling on the first move it is allowed to keep and the moves stop being cancelable after that.

Because the pan is visible it no longer has to start at an edge. `dragAxis` locks the axis at 10px — far sooner than `swipeDirection`'s 56px, and biased towards vertical so an ambiguous drag stays a scroll — and the pan may begin anywhere, **including over a window**: a phone card is the whole screen, so a pan that refused to start on one was a pan with almost nowhere left to start from. What it gives way to is not the card but a drag something under the finger already had a use for, and `panBlockFrom` answers that **per direction** — a sideways scroller blocks the way it can still scroll and hands back the way it cannot, the same bargain `canPullFrom` makes with a list already at its top, so the direction the pan set off in (locked with the axis, in `Drag.panning`) decides whether it is the shell's. `data-no-pan` (the palette, the drawing canvas) and a slider — `role="slider"` or `input[type=range]`, a sideways drag that never scrolls — are the outright refusals. `shouldCommitDrag` decides the landing on distance *or* flick speed — the same rule for the shade pull, so a flick means the same thing on both axes; anything else settles back.

The palette is a **bottom sheet** on a phone: collapsed to a labelled handle by default, so the screen belongs to the card. Collapsed it is translated down by its own height less the handle, and `--palette-h` is published from the handle's height instead of the container's — a rect read mid-transition would hand the cards a height about to be wrong. The sheet body is `inert` while collapsed so its textarea cannot be focused off the bottom edge. The two sheets are mutually exclusive: raising one lowers the other.

To try any of this on a PC: `make claude-dev-mobile`. A narrow window is only half of a phone — the other half is touch, which a mouse does not produce — so it opens a phone-shaped Chrome on its own profile and `scripts/dev/emulate-mobile.ts` attaches over CDP to turn mouse drags into real touch streams. See the `MOBILE` entry in the root `CLAUDE.md`.

The pull-up raises the sheet on **touchmove**, as soon as the pull has said "up", so the slide and the rest of the drag overlap. The keyboard is a separate problem: a phone opens it only for a `focus()` that a user gesture is still activating, so `openSheetWithKeyboard` focuses from inside the touchend/click handler — clearing `inert` on the node first, since React has not re-rendered yet — rather than from the effect keyed on `sheetOpen`. That effect stays as the fallback for every other way the sheet can open.

Notifications render in `NotificationShade` on a phone and in `NotificationCenter` on a desktop, because a top-right stack lands on a card's title bar. The auto-dismiss timers stay in `NotificationCenter` either way, so one component owns expiry. The pull-down is the only way into the shade: a floating badge used to offer a second one while notifications were waiting, and it parked a pill over the card for a gesture that is already the phone's habit.

The shade is the phone's **status surface** as well: `DesktopStatusBar` renders nothing at all on a phone — a pill that says "Connected" all session, dot included, is chrome a 412px screen has no room for — and the connection reading and the agent roster are shown inside the pull-down instead. `components/desktop/AgentStatus.tsx` holds the two pieces (`ConnectionStatus`, `AgentRoster`) both surfaces render, so they cannot drift. Because the shade now always has something in it, it no longer closes itself when the last notification goes; a pull-down on a quiet session used to look like a gesture that did not work. A disconnection is reported there and nowhere else.

It is the phone's **navigation surface** too: `MonitorTabs` (the monitor switcher and its "+") and `Taskbar` (the window tabs) render inside the shade rather than around the input bar — `CommandPalette` gates both behind `!isMobile` — because the bottom edge of a phone is the palette's collapsed sheet, and two strips of chips stacked on it spent a small screen on chrome that is only wanted between one thing and the next. A tap in either row leaves the sheet where it is: monitors are switched and windows raised in runs, and a shade that closed itself on the first tap would have to be pulled back down for the second — it goes away the way it came, by the grip or the backdrop. A monitor chip is also *shorter* there (`shortLabel` drops the "Monitor " prefix, since the section is headed "Monitors" already; the full label stays in `title`) but a step **larger** — a single digit centred in a 44px target is the whole label, so it takes `--text-lg` where the desktop chip takes `--text-base`. The row is shown even with **one** monitor, which the desktop hides: there the row sits against the input bar, where a lone chip is chrome for a choice nobody has, while here a "Monitors" heading over nothing but a "+" reads as a list that failed to load. The "+" sits against the last chip rather than at the right margin (`margin-left: auto` is undone for the phone) so it reads as the end of that list. The chip carries **no ×**: with no hover to bring one out of, an × would sit permanently under the thumb that switches monitors, so the phone **flicks the chip up** to close a monitor instead. `MonitorTabs` recognises that one itself — `dragAxis` / `shouldCommitDrag` from `lib/gestures.ts` again, `touch-action: pan-x` so the row keeps its sideways scroll, and the transform written straight to the chip rather than through React. The session's own monitor (`DEFAULT_MONITOR_ID`) has no handlers at all, because the server refuses to delete it; and since `removeMonitor` is a *request*, a thrown chip that no `MONITORS` answer unmounts is put back after `LIFT_RESTORE_MS`. The phone-only rules at the foot of `styles/taskbar/Taskbar.module.css` are therefore all about a row sitting in that sheet.

On a phone the **context reset is not in the palette**: the palette row is under the thumb all session, the wrong place for a destructive control, so the pen takes the reset's slot there and the reset (`components/command-palette/ContextResetButton.tsx`, the one component both homes render) sits at the right end of the shade's status row. The palette's icon cluster steps aside while the textarea is focused, except for the pen, which stays — a sketch is something added to the message being typed. The desktop palette is unchanged.

The phone's **Back button** puts away one layer per press instead of leaving YAAR (issue #118). `hooks/usePhoneBack.ts` keeps a *guard* history entry (`{ yaarBackGuard: true }`) on top of the page; Back pops it, `popstate` runs `stepBack` (`lib/phoneBack.ts`), and the guard goes back on. The order is what the user sees, top first: the `useDismissable` Escape stack (dialogs, the shade — `dismissTopSurface`), the palette sheet, a full-screen card, the CLI, then the top card, which is **minimized, never closed** (closing retires its app agent, and Back gets pressed in runs). On a bare desktop the guard stays off and a toast says "press back again to exit", so the second Back is a real one; it is re-armed after `EXIT_HINT_MS`. Chrome skips on Back an entry pushed without a user touch since, so before the first tap Back still leaves — as it did before. An app iframe that navigates adds its own joint-history entries, and Back walks those first.

## CLI Panel

`Shift+Tab` toggles `cliMode` (`store/slices/cliSlice.ts`) — on a phone it is the left-hand end of the sideways pan instead, see Phone gestures — rendering `CliPanel` — a tmux-style grid of `TerminalPane`s streaming each monitor's agent. A phone gets **one** pane (two terminals on 412px are two unreadable columns), so the grid cannot be its monitor switcher and the pan out of the CLI goes back to the desktop rather than along the monitor list: it gets numbered **monitor buttons** in a top bar instead, matching the pane badges. That bar (`.topBar`, `display: contents` on a desktop so the target toggle keeps placing itself over the grid) is a real row on a phone that the panel is padded for — the controls used to float over the pane, landing on its header's own Copy/Clear buttons. The panel also carries a **Monitor / Session ("act as me")** target toggle (`cliTarget` in the cli slice): `'session'` routes typed messages to the session agent — the user's deputy that can drive the real browser via `yaar://session/browser`. `sendMessage` (in `lib/transport/commands.ts`) attaches `target: 'session'` to `USER_MESSAGE` only while the CLI panel is open and the toggle is set; the main command palette always stays on the monitor agent.

## WebSocket Connection

One singleton WebSocket with auto-reconnect (exponential backoff), reconnecting with `?sessionId=X` (rejoin) and `?token=X` (remote auth).

**There is one socket, so there is one owner.** `useAgentConnectionOwner()` (in `hooks/useAgentConnection.ts`) is mounted **exactly once**, by `DesktopSurface`, and is the only thing that calls `connect()` or mounts `useClientPresence` / `usePendingEventDrainer` / `useMonitorSync`. Everything a component actually wants — `sendMessage`, `reset`, `sendDialogFeedback`, `retryConnection`, … — is a **plain module function** imported from the same file; only `useIsConnected()` is a hook, and it subscribes to the transport and nothing else. Do not add a second mount point: the sub-hooks install global listeners and store subscriptions against the singleton, so a second one does not add redundancy, it doubles the frames — a second `CLIENT_PRESENCE` per backgrounding, a second `RESYNC` per resume (hence a second authoritative `SNAPSHOT` replacing desktop state), a second `SUBSCRIBE_MONITOR` per monitor switch, and a second full walk of the window map per streamed token. This hook *was* called by five live components, and stayed correct only by accident: `createConsumeQueue` empties in one synchronous step so the redundant drains found nothing, and `openSocket`'s `readyState` guard refused the extra sockets.
- The React-free half lives in `lib/transport/` — it is the app's transport, imported by `store/` and `lib/` as well as by hooks, so it must not sit under `hooks/`: `connection` (socket lifecycle — `connect`/`disconnect`/`retryConnection`/`recoverAfterResume`, the liveness probe, the inbound handler), `commands` (every outbound frame), `transport-manager`, `server-event-dispatcher`, `outbound-command-helpers`, `liveness-probe`, `pending-queues` (`drainPendingQueues`), `frames` (`monitorSubscription`, `clientPresence` — the frames the reconnect path sends on the hooks' behalf), `iframe-token-refresh`. `hooks/use-agent-connection/` keeps only the three real hooks: `usePendingEventDrainer`, `useMonitorSync`, `useClientPresence`
- `usePendingEventDrainer` drains store queues (feedback, app protocol responses, interactions) over WS
- `useMonitorSync` sends `SUBSCRIBE_MONITOR` (which monitor *this connection* is on, its viewport, and its `formFactor`) on connect, active-monitor change, form-factor change, and viewport resize — always built by `monitorSubscription()`. It does **not** announce monitor creation/deletion: the monitor list is server state, so `monitorSlice` asks for changes directly (`ADD_MONITOR` / `REMOVE_MONITOR`) and applies the server's `MONITORS` answer. See `docs/architecture/monitor_and_windows_guide.md`.
- `useClientPresence` sends `CLIENT_PRESENCE` (`visible` / `hidden` / `frozen`) on `visibilitychange` and the Page Lifecycle `freeze`/`resume` events, and re-announces on every (re)connect. **An open socket is not a live desktop**: a backgrounded tab keeps its WebSocket while running no script, so without this frame every server→client wait against it — `app_query`, window capture, the 2s render confirm — times out and reports the app as broken, across every window at once. Measured against real Chrome, a frozen tab held its socket for 264s, past the 255s transport idle timeout, because the server's own sends keep resetting the idle clock. The server records it per connection (`session/client-presence.ts`) and appends the reason to those timeouts; it changes no other behavior.
- Coming back is also its own recovery trigger, not just socket close: the same hook re-runs `flushPending()` + `RESYNC` on `resume`, or after being hidden longer than `RESYNC_AFTER_HIDDEN_MS`. Reattach was the only path before, which left a tab that froze and resumed *without* the socket dropping talking to a server that had given up on it. Short flicks away deliberately skip it — a snapshot rebuilds every surface, and nothing can have expired in that time. What it does **not** do any more is reload the apps: `applySnapshot` keeps the iframe token of a window already on screen, because the token rides in the frame's `src` and the server re-mints one per reported window. That re-mint on every resume was reloading every open app on every app switch, which is how devtools kept coming back with no project open. `lib/transport/iframe-token-refresh.ts` is now the only thing that re-mints for a window the client holds, and it runs on exactly the attaches where the old token is dead (`recoveryMode` other than `attached`/`created`).
- **And that recovery is then checked**, by `liveness-probe.ts`. "The socket survived the freeze" is what our end claims, not a fact: a phone that spent a few minutes in another app usually comes back holding a socket whose peer is long gone, and `readyState` reads `OPEN` until the OS gives up on the TCP connection — minutes. Every send succeeds into the void and no `onclose` ever fires, so the reconnect path, which *begins* at `onclose`, never starts: the desktop shows itself connected and answers nothing until the tab is reloaded. The `RESYNC` above owes us a `SNAPSHOT`, so the resume path arms a deadline (`LIVENESS_PROBE_TIMEOUT_MS`, 8s) against it; any inbound frame at all disarms it. Silence past the deadline calls `replaceDeadSocket()`, which does *not* wait on `close()` — a peer that is gone sends no close frame, so the socket would sit in `CLOSING` — but drops the reference and connects again immediately, which `openSocket`'s existing `isCurrent()` guard already makes safe. A socket stuck in `CONNECTING` gets the same deadline with nothing sent, since `openSocket` refuses to replace one and nothing else would ever clear it.
- `reset()` is a **delivery, not a gesture**: it carries a `messageId`, goes into the outbox beside user messages, and is resent on the next attach until the server acks it (`MESSAGE_ACCEPTED` with `agentId: NO_AGENT_ACK`, which settles the outbox without filing a status chip). `send()` returning true only means the frame reached our end of the socket; a resumed phone routinely holds one whose peer is gone, and the desktop used to clear itself against a server that never heard a word. The local clear still happens on the spot — the ack is immediate, `resetSession` is not.
- Event types defined in `@yaar/shared` — grep `events/client.ts` and `events/server.ts` for schemas

## Service Worker

`public/sw.js`, registered from `main.tsx` via `lib/registerServiceWorker.ts` after the first render. It caches the **shell**, so an installed YAAR opens like an app: a phone discards a backgrounded tab, and reopening from the home screen is a cold document load against a server that may be a Termux process on the same phone still waking up. It is **not** background execution — nothing here talks to the agent, and the page still has to be open.

Three request kinds, everything else left to the browser with no `respondWith` at all: the desktop document (`destination === 'document'`) is network-first with a 2.5s deadline then the cached shell — network-first because bundle filenames are content-hashed into the HTML, so a stale shell points at scripts that are gone; content-hashed build output is cache-first and never revalidated; fixed-name `public/` assets (the 10.5 MB of webfonts, icons, manifest) are stale-while-revalidate. `/api/*` is never cached, and app iframe documents are `destination === 'iframe'` rather than `'document'`, so they fall through even in the local-dev origin mode where an app shares this origin.

Two things it has to survive. It needs a **secure context**, so on `http://192.168.x.x:8000` — the usual way to reach YAAR from a phone — `navigator.serviceWorker` is undefined and registration returns quietly; remote mode over Tailscale Serve and `localhost` do get it. And if the worker is itself the problem, `?nosw` on the URL unregisters it and empties its caches, which is a shorter road back than clearing site data on a phone.

## Dialogs

Every blocking dialog renders inside `components/overlays/Modal.tsx`, and every surface that Escape or a press outside should put away uses `hooks/useDismissable.ts`. Escape goes to the **most recently opened** surface only (a module-level stack), so a dialog raised over the notification shade takes the first Escape and the shade the second — two hand-rolled `document` listeners used to close both on one keypress, and four dialogs had no Escape at all. `Modal` adds `role="dialog"` + `aria-modal`, keeps Tab inside, and hands focus back on close. It focuses the **backdrop**, not the first button, when nothing inside claimed focus: these dialogs are raised by an agent, often mid-sentence in the palette, and the next Enter the user was already going to press must not land on Cancel. Escape on `ConfirmDialog` is Cancel *once* — never a remembered deny, even with the box ticked — and on `UserPrompt` it is Skip, or nothing when the prompt allows no skip. `ConnectionDialog` takes no `onDismiss`: there is no server behind it to go back to. `CommandPalette`'s two outside-press listeners deliberately stay hand-rolled — each is paired with an iframe-click or window-`blur` signal the hook knows nothing about.

## Styles

`styles/` mirrors `components/` (`components/overlays/Foo.tsx` → `styles/overlays/Foo.module.css`) instead of sitting beside it. Nothing in the history records why, and the layout has a cost you need to know about: **deleting a component does not put its stylesheet in front of you.** Twice a cleanup found every other trace of a feature and missed the `.module.css` in the parallel tree, so `tests/design/orphan-styles.test.ts` now fails on any module nothing imports. The file names are also only half-true — `DesktopSurface.module.css` is imported by four components (`AgentStatus` among them), and the `WindowFrame`, `Taskbar` and `CliPanel` modules serve two each — so grep for the importers before assuming a stylesheet belongs to the component it is named after.

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

The package's `test` script passes **`--isolate`**, and four component tests depend on it.
`mock.module` is process-global with no teardown, so `ConfirmDialog`, `UserPrompt` and the two
`CommandPalette` files — each replacing `@/hooks/useAgentConnection` with a stub exporting only
the one function it asserts on — replace it *for every file that loads after them*. `components/`
sorts before `hooks/`, so `reset-delivery.test.tsx` got a module whose `reset` was `undefined` and
failed three cases on a bug in neither the module nor itself. `--isolate` gives each file a fresh
module registry, which is the same fix the server's `units` partition already relies on — see the
header of `scripts/test/partitions.ts`. Drop the flag and those three come back.
