# OS Actions Reference

OS Actions are the JSON commands the AI emits to control the desktop. The frontend receives them via WebSocket (`ACTIONS` event) and applies them to create windows, display notifications, and manage the desktop surface.

**Source:** `packages/shared/src/actions.ts`

---

## Window Actions

### `window.create`

Create a new window on the desktop.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'window.create'` | yes | |
| `windowId` | `string` | yes | Unique window identifier |
| `title` | `string` | yes | Title displayed in the titlebar |
| `bounds` | `WindowBounds` | yes | Position and size: `{ x, y, w, h }` |
| `content` | `WindowContent` | yes | Content payload: `{ renderer, data }` |
| `requestId` | `string` | no | Tracking ID for iframe load feedback |
| `appId` | `string` | no | App this window belongs to |
| `variant` | `'standard' \| 'widget' \| 'panel'` | no | Window layer (default: `'standard'`). Widgets sit below standard windows; panels are fixed-position. |
| `dockEdge` | `'top' \| 'bottom'` | no | Dock edge for panel variant |
| `frameless` | `boolean` | no | Hide the titlebar |
| `windowStyle` | `Record<string, string \| number>` | no | Custom CSS styles on the window element |
| `minimized` | `boolean` | no | Create in minimized state |
| `iframeToken` | `string` | no | Token for iframe route restriction |
| `isolateOrigin` | `boolean` | no | Serve the iframe from the sibling loopback origin, cross-origin to the desktop (app-origin isolation) |

**Behavior:**
- Bounds are clamped to the viewport.
- Variant determines z-order layer: panels are excluded from stacking, widgets stack below standard windows.
- Standard windows steal focus on creation unless `minimized` is true.

### `window.close`

Close and remove a window.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'window.close'` | yes |
| `windowId` | `string` | yes |

If the closed window was focused, focus moves to the topmost remaining window.

Closing a window also settles every app-protocol request still addressed to it, as `closed` rather than as a timeout — see [App Protocol](./app_protocol_reference.md). A command that closes its own window can never be answered, and waiting out its deadline reports "the app did not respond" for an operation that succeeded.

### `window.reload`

Re-mount a window's content without destroying the window.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'window.reload'` | yes |
| `windowId` | `string` | yes |

- The window record, its bounds, its iframe token, its subscriptions and its app agent all survive — no close fires, so none of the window-close teardown runs.
- The iframe's in-memory state does **not** survive. Anything an app needs across a reload belongs in `appStorage`/`appDb`.
- Refused while another agent holds the window's lock, like `window.close`.

This is how a window picks up a redeployed bundle without losing its app agent's context. A deploy closes the app's other windows but cannot close the one it was issued from (see `features/apps/retire.ts`), which is reported back as `staleWindow`; reloading that window is the non-destructive fix.

### `window.focus`

Bring a window to the front.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'window.focus'` | yes |
| `windowId` | `string` | yes |

- Standard windows move to top of z-order.
- Widgets move to top of the widget layer (still below standard).
- Panels are unaffected.
- Unminimizes the window if it was minimized.

This is the only action that changes stacking apart from `window.create` (which puts the new window on top of its layer) and `window.close`. The server mirrors the result — see [Window State](#window-state) — so an agent can read which window is on top without asking the desktop.

### `window.minimize`

Hide a window from the viewport.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'window.minimize'` | yes |
| `windowId` | `string` | yes |

Widgets and panels cannot be minimized (no-op).

### `window.maximize`

Maximize a window to fill the viewport.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'window.maximize'` | yes |
| `windowId` | `string` | yes |

Previous bounds are saved for later restore.

### `window.restore`

Restore a maximized or minimized window to its previous state.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'window.restore'` | yes |
| `windowId` | `string` | yes |

- If maximized: restores to the saved `previousBounds`.
- If minimized: makes the window visible again.

### `window.move`

Move a window.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'window.move'` | yes |
| `windowId` | `string` | yes |
| `x` | `number` | yes |
| `y` | `number` | yes |

### `window.resize`

Resize a window.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'window.resize'` | yes |
| `windowId` | `string` | yes |
| `w` | `number` | yes |
| `h` | `number` | yes |

### `window.setTitle`

Change a window's title.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'window.setTitle'` | yes |
| `windowId` | `string` | yes |
| `title` | `string` | yes |

### `window.setContent`

Replace the entire content of a window.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'window.setContent'` | yes |
| `windowId` | `string` | yes |
| `content` | `WindowContent` | yes |

Lock-protected: only the agent holding the lock can update a locked window.

### `window.updateContent`

Incrementally update window content with a diff operation.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'window.updateContent'` | yes | |
| `windowId` | `string` | yes | |
| `operation` | `ContentUpdateOperation` | yes | See operations below |
| `renderer` | `string` | no | Optionally change the renderer type |

**ContentUpdateOperation variants:**

| `op` | Fields | Valid renderers | Description |
|------|--------|-----------------|-------------|
| `'append'` | `data: unknown` | markdown, html, text | Append text to content (requires string data) |
| `'prepend'` | `data: unknown` | markdown, html, text | Prepend text to content (requires string data) |
| `'insertAt'` | `data: unknown`, `position: number` | markdown, html, text | Insert text at character position (requires string data) |
| `'replace'` | `data: unknown` | all | Replace entire content data |
| `'clear'` | — | all | Reset content to empty |

Lock-protected.

### `window.lock`

Lock a window so only the specified agent can modify it.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'window.lock'` | yes |
| `windowId` | `string` | yes |
| `agentId` | `string` | yes |

Other agents' `setContent` / `updateContent` calls will fail while locked.

### `window.unlock`

Release a window lock.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'window.unlock'` | yes |
| `windowId` | `string` | yes |
| `agentId` | `string` | yes |

The `agentId` must match the agent that acquired the lock.

### `window.capture`

Capture a window's content as a PNG screenshot.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'window.capture'` | yes |
| `windowId` | `string` | yes |
| `requestId` | `string` | required in practice |

Async operation. Sends a `yaar:capture-request` postMessage to the window's iframe and awaits a `yaar:capture-response` (2s timeout); the injected capture script handles canvas and DOM (via `foreignObject`) capture using the browser's native CSS engine. There is no fallback tier — if the iframe doesn't respond in time, or responds with no image data, capture fails outright. Returns base64 PNG via `RENDERING_FEEDBACK` (`success: true, imageData`) on success, or `success: false` with an `error`/`captureFailure` reason (e.g. `no-response`) on failure. `requestId` is typed optional but is not: `packages/frontend/src/store/desktop.ts`'s handler only calls `captureWindow` `if (requestId)` — an action sent without it returns early with no capture and no warning.

### Window State

The actions above mutate state the actions themselves never spell out. Two types hold it, and they
are deliberately not the same shape — the server tracks what it must re-emit on restore, the
frontend tracks what it must draw.

**`WindowState`** (`packages/shared/src/actions.ts`) — the server's record, and what session restore
replays. It extends `WindowPresentation` (`appId`, `variant`, `dockEdge`, `frameless`,
`windowStyle`, `minimized`, `isolateOrigin`, `appOrigin` — the same fields `window.create` accepts)
and adds:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Window id |
| `title` | `string` | Current title (`window.setTitle` writes it) |
| `bounds` | `WindowBounds` | Current position and size |
| `content` | `WindowContent` | Current content (`window.setContent` / `updateContent` write it) |
| `locked` | `boolean` | Whether a lock is held (`window.lock` / `unlock`) |
| `lockedBy` | `string?` | Agent id holding the lock |
| `appProtocol` | `boolean?` | The iframe has registered an App Protocol manifest |
| `createdAt` / `updatedAt` | `number` | Epoch ms |

**`WindowModel`** (`packages/frontend/src/types/state.ts`) — the store's record. Same fields plus
the ones only the desktop knows: `maximized: boolean` and `previousBounds?` (written by
`window.maximize`, read by `window.restore`), `minimized: boolean` (non-optional here),
`monitorId`, `requestId`, `iframeToken`. **`maximized` / `previousBounds` are frontend-only** —
the server never sees them, so a maximized window comes back from session restore at its saved
`bounds`.

#### Stacking order

The desktop's `zOrder` (an array, bottom to top) is **mirrored server-side** by
`WindowStateRegistry`, because the server sees every input that moves a window in the pile:
`window.create` and `window.focus` from an agent, a click-to-focus or a taskbar restore as a
`window.focus` user interaction, and a close from either side. The layering rules are the same on
both sides and must stay in step:

| Variant | Stacking |
|---------|----------|
| `standard` | Goes on top on create and on focus |
| `widget` | Own layer, always below every standard window — focusing one does not promote it |
| `panel` | Outside the stack entirely (fixed position); reported as `fixed`, never with a `z` |

`maximized` is deliberately **not** mirrored: the frontend computes those bounds from a viewport
the server does not have.

Three doors report the result, each ranking a window among *its own monitor's* windows, `0` at the
bottom:

| Door | What it shows |
|------|---------------|
| `list('yaar://windows')` | Links ordered bottom to top — the last one is on top. Each carries `renderer`, `WxH`, `z:{n}` (or `fixed`), then `focused`, `locked`, `minimized`, `app:{appId}` when each applies |
| `read('yaar://windows/{id}')` | `z` and `focused` alongside the rest of the metadata; `z` is absent on a panel |
| `<open_windows>` in the agent's turn | Lines in stacking order, each with `z:{n}` and, for overlaps, `covered by …` / `covers …` rather than a bare `overlaps` — a covered window is one the user cannot see |

### Built-in Window State Keys

Three state keys belong to the *window* rather than to the app inside it, and they are readable
without any action at all. `__` is reserved: an app state key by one of these names is shadowed.

| Key | Answers | Available on |
|-----|---------|--------------|
| `__content` | the window registry — no capture, no round trip to the app | every window |
| `__screenshot` | a `window.capture` round trip to the frontend | iframe windows |
| `__console` | the injected app-protocol script's capture buffer | iframe windows |

They are addressed as `yaar://windows/{windowId}/state/__content` and friends. A bare
`read('yaar://windows/{windowId}')` is metadata + `__content`, or metadata + `__screenshot` on an
iframe window (with `contentOmitted` naming where the content went). Full verb table:
[URI Reference → Windows](./uri_reference.md#windows--yaarwindowswindowid).

---

## Notification Actions

Notifications are addressable as `yaar://user/notifications/{id}` — see [URI-Based Resource Addressing](../architecture/verbalized-with-uri.md).

### `notification.show`

Show a persistent notification.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'notification.show'` | yes | |
| `id` | `string` | yes | Unique notification ID |
| `title` | `string` | yes | |
| `body` | `string` | yes | |
| `icon` | `string` | no | Icon name |
| `duration` | `number` | no | Auto-dismiss after this many ms (persists until dismissed if omitted) |

### `notification.dismiss`

Dismiss a notification.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'notification.dismiss'` | yes |
| `id` | `string` | yes |

---

## Toast Actions

### `toast.show`

Show a temporary toast message.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'toast.show'` | yes | |
| `id` | `string` | yes | Unique toast ID |
| `message` | `string` | yes | |
| `variant` | `'info' \| 'success' \| 'warning' \| 'error'` | no | Visual style (default: `'info'`) |
| `action` | `{ label: string; eventId: string }` | no | Optional action button |
| `duration` | `number` | no | Auto-dismiss timeout in ms |

When the action button is clicked, the frontend sends a `TOAST_ACTION` event to the server with the `eventId`.

### `toast.dismiss`

Dismiss a toast.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'toast.dismiss'` | yes |
| `id` | `string` | yes |

---

## Dialog Actions

### `dialog.confirm`

Show a modal confirmation dialog.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'dialog.confirm'` | yes | |
| `id` | `string` | yes | Unique dialog ID |
| `title` | `string` | yes | |
| `message` | `string` | yes | |
| `confirmText` | `string` | no | Confirm button label (default: `'Yes'`) |
| `cancelText` | `string` | no | Cancel button label (default: `'No'`) |
| `permissionOptions` | `PermissionOptions` | no | Permission persistence config |
| `capabilities` | `CapabilityLine[]` | no | Structured version of what is being asked for. When present the dialog renders these instead of `message`'s body; `message` stays the fallback for a client too old to know the field. |

**PermissionOptions:**

| Field | Type | Description |
|-------|------|-------------|
| `showRememberChoice` | `boolean` | Show "Remember my choice" checkbox |
| `toolName` | `string` | Tool name for saving the decision |
| `context` | `string?` | Optional context identifier |

**CapabilityLine** — one thing being granted, said in the user's terms (the app-install dialog is the consumer). The server decides what each grant means; the frontend only lays these out.

| Field | Type | Description |
|-------|------|-------------|
| `icon` | `string` | Single emoji, rendered as the row's icon |
| `title` | `string` | The capability in plain language: "Read and write your files" |
| `detail` | `string?` | Optional qualifier: "Requests to allowed domains" |
| `raw` | `string?` | The literal grant this describes (`yaar://storage/`, `yaar-web`), shown demoted |
| `warn` | `boolean?` | Broad or privileged — rendered with a warning accent |

The user's response is sent back to the server as a `DIALOG_FEEDBACK` event. If `permissionOptions` is set and the user checks "remember", the decision is persisted to `config/permissions.json`.

### `dialog.close`

Take a dialog off the screen without an answer.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'dialog.close'` | yes | |
| `id` | `string` | yes | ID of the dialog to close |
| `reason` | `'timeout'` | no | Why it left the screen. `'timeout'` means the server stopped waiting for an answer. |

A confirm dialog has a deadline the user can't see. When it passes, the server stops listening and the waiting tool is told "denied" — `dialog.close` clears the dialog from the screen so its buttons don't stay wired to a request that no longer exists.

---

## App Actions

### `app.badge`

Set a badge count on a desktop app icon.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'app.badge'` | yes | |
| `appId` | `string` | yes | App folder name in `apps/` |
| `count` | `number` | yes | Badge count (0 clears the badge) |

---

## Desktop Actions

### `desktop.refreshApps`

Trigger a re-fetch of the app list from `GET /api/apps`.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'desktop.refreshApps'` | yes |

### `desktop.createShortcut`

Add a shortcut to the desktop.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'desktop.createShortcut'` | yes |
| `shortcut` | `DesktopShortcut` | yes |

**DesktopShortcut:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique shortcut ID |
| `label` | `string` | Display name |
| `icon` | `string` | Emoji or image path |
| `iconType` | `'emoji' \| 'image'` | Icon kind (optional) |
| `target` | `string` | URI target: `yaar://apps/{id}`, `yaar://storage/{path}`, `https://...`, or legacy app ID |
| `osActions` | `OSAction[]` | Optional client-side actions to execute on click (bypasses AI round-trip) |
| `skill` | `string` | Optional inline skill instructions sent to AI when clicked |
| `folderId` | `string` | If set, this shortcut belongs to a folder |
| `createdAt` | `number` | Creation timestamp |

### `desktop.removeShortcut`

Remove a desktop shortcut.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'desktop.removeShortcut'` | yes |
| `shortcutId` | `string` | yes |

### `desktop.updateShortcut`

Update fields on an existing shortcut.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'desktop.updateShortcut'` | yes | |
| `shortcutId` | `string` | yes | |
| `updates` | `Partial<DesktopShortcut>` | yes | Partial fields to merge (excludes `id` and `createdAt`) |

### `desktop.updateSettings`

Update desktop-wide settings.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'desktop.updateSettings'` | yes |
| `settings` | `DesktopSettings` | yes |

**DesktopSettings:**

| Field | Type | Description |
|-------|------|-------------|
| `userName` | `string` | Optional display name |
| `language` | `string` | Optional UI language |
| `wallpaper` | `string` | Optional wallpaper path/URL |
| `accentColor` | `string` | Optional accent color |
| `iconSize` | `'small' \| 'medium' \| 'large'` | Optional desktop icon size |
| `theme` | `'dark' \| 'light'` | Optional color theme |

---

## Window Content

A `WindowContent` is `{ renderer: string; data: unknown }`. The `renderer` field selects how `data` is interpreted.

| Renderer | `data` type | Description |
|----------|-------------|-------------|
| `'markdown'` | `string` | Markdown text |
| `'html'` | `string` | Raw HTML |
| `'text'` | `string` | Plain text |
| `'table'` | `TableContentData` | Structured table |
| `'iframe'` | `string \| IframeContentData` | Embedded iframe (URL string or object) |
| `'component'` | `ComponentLayout` | Interactive UI components |

**TableContentData:** `{ headers: string[]; rows: string[][] }`

**IframeContentData:** `{ url: string; sandbox?: string }`

### Component Layout

```typescript
{
  components: Component[];  // Flat array, no nesting
  cols?: number | number[]; // Grid columns: single number or ratio array (e.g. [8, 2])
  gap?: 'none' | 'sm' | 'md' | 'lg';
}
```

**Source:** `packages/shared/src/components.ts`

#### Component Types

The tables below give each field's type per the narrower, component-specific TypeScript types in
`component-types.ts` (what a well-formed component should have). The actual validating schema
(`componentSchema` in `components.ts`) is flatter and more permissive: every field across every
component type is `z.string()`/etc. `.optional()` except `type` itself, so a request missing e.g.
`button.label` or `image.src` is not rejected at validation time — the `Required` column reflects
the TS-type intent, not a runtime guarantee.

**button**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'button'` | yes | |
| `label` | `string` | yes* | Button text |
| `action` | `string` | yes* | Message sent to agent on click |
| `variant` | `'primary' \| 'secondary' \| 'ghost' \| 'danger'` | no | |
| `size` | `'sm' \| 'md' \| 'lg'` | no | |
| `icon` | `string` | no | Icon name |
| `disabled` | `boolean` | no | |
| `parallel` | `boolean` | no | Run action in parallel (default: true) |
| `submitForm` | `string` | no | Form ID to collect data from on click |

**input**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'input'` | yes | |
| `name` | `string` | yes* | Field name in form data |
| `formId` | `string` | no | Form ID (referenced by button `submitForm`) |
| `label` | `string` | no | |
| `placeholder` | `string` | no | |
| `defaultValue` | `string` | no | |
| `variant` | `'text' \| 'email' \| 'password' \| 'number' \| 'url'` | no | |
| `rows` | `number` | no | Renders as textarea when set |
| `disabled` | `boolean` | no | |

**select**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'select'` | yes | |
| `name` | `string` | yes* | Field name in form data |
| `options` | `{ value: string; label: string }[]` | yes* | |
| `formId` | `string` | no | |
| `label` | `string` | no | |
| `defaultValue` | `string` | no | |
| `placeholder` | `string` | no | |
| `disabled` | `boolean` | no | |

**text**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'text'` | yes | |
| `content` | `string` | yes* | Text content |
| `variant` | `'body' \| 'heading' \| 'subheading' \| 'caption' \| 'code'` | no | |
| `color` | `'default' \| 'muted' \| 'accent' \| 'success' \| 'warning' \| 'error'` | no | |
| `textAlign` | `'left' \| 'center' \| 'right'` | no | |

**badge**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'badge'` | yes | |
| `label` | `string` | yes* | |
| `variant` | `'default' \| 'success' \| 'warning' \| 'error' \| 'info'` | no | |

**progress**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'progress'` | yes | |
| `value` | `number` | yes* | 0–100 |
| `label` | `string` | no | |
| `variant` | `'default' \| 'success' \| 'warning' \| 'error'` | no | |
| `showValue` | `boolean` | no | Show percentage text |

**image**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'image'` | yes | |
| `src` | `string` | yes* | Source URL |
| `width` | `number \| string` | no | Width in px or CSS value |
| `height` | `number \| string` | no | Height in px or CSS value |
| `fit` | `'contain' \| 'cover' \| 'fill'` | no | Object fit mode |

\* Required by the TS type; the runtime schema accepts the component without it (see note above).

---

## User Prompt Actions

User prompts are addressable as `yaar://user/prompts/{id}` — see [URI-Based Resource Addressing](../architecture/verbalized-with-uri.md).

### `user.prompt.show`

Show a structured prompt dialog (powers the `ask` and `request` MCP tools).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'user.prompt.show'` | yes | |
| `id` | `string` | yes | Unique prompt ID |
| `title` | `string` | yes | |
| `message` | `string` | yes | |
| `options` | `UserPromptOption[]` | no | Selectable options (ask-style) |
| `multiSelect` | `boolean` | no | Allow multiple selections |
| `inputField` | `UserPromptInputField` | no | Text input config (request-style) |
| `allowDismiss` | `boolean` | no | Whether the user can dismiss without answering |

### `user.prompt.dismiss`

Dismiss a user prompt.

| Field | Type | Required |
|-------|------|----------|
| `type` | `'user.prompt.dismiss'` | yes |
| `id` | `string` | yes |

The user's response is sent back via `USER_PROMPT_RESPONSE` client event.

---

## Clipboard Actions

The clipboard is the browser's, not the server's, and that is the whole shape of these actions.
Under `REMOTE=1` the machine running YAAR and the machine holding the clipboard are routinely not
the same machine; even locally, only the page has `navigator.clipboard`. So every clipboard
operation is a round trip — this action out, a `CLIPBOARD_RESPONSE` client event back, matched on
`id`. Neither action touches store state (`handleClipboardAction` in
`packages/frontend/src/lib/clipboard.ts`).

Every ceiling below is set by the server and applied by the desktop, so an oversized clipboard is
trimmed *before* it crosses the socket rather than after.

### `user.clipboard.read`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'user.clipboard.read'` | yes | |
| `id` | `string` | yes | Matched by the `requestId` on the response |
| `maxChars` | `number` | yes | Ceiling on returned text. Past it the desktop trims and reports the true length. |
| `image` | `boolean` | yes | Read an image if one is there. `false` skips the decode/encode entirely. |
| `maxImagePx` | `number` | yes | Longest edge in px an image is downscaled to before encoding. `0` disables downscaling. |
| `maxImageBytes` | `number` | yes | Hard ceiling on the encoded image. Over it, the read reports `too-large`. |

### `user.clipboard.write`

| Field | Type | Required |
|-------|------|----------|
| `type` | `'user.clipboard.write'` | yes |
| `id` | `string` | yes |
| `text` | `string` | yes |

**`CLIPBOARD_RESPONSE`** (`packages/shared/src/events/client.ts`) carries `requestId`, `ok`, and
then `text` / `totalChars` / `truncated` / `image`, or a machine-readable `reason`: `denied`,
`not-focused`, `unsupported`, `empty`, `too-large`, `failed`. They are not interchangeable — a
denied read is fixed by granting clipboard access, an unfocused one by clicking the desktop first,
an empty one by copying something.

Clipboard **text** is scanned for vendor-prefixed credentials on the server before it reaches an
agent (`YAAR_CLIPBOARD_SECRETS`, on by default); images are not scanned. See
`packages/server/CLAUDE.md`.

---

## Union Type

All actions are represented by the `OSAction` union:

```typescript
type OSAction =
  | WindowAction
  | NotificationAction
  | ToastAction
  | DialogAction
  | UserPromptAction
  | UserClipboardAction
  | AppAction
  | DesktopAction;
```

## Validation Helpers

Narrowing an `OSAction` is done by discriminating on `type` directly (`action.type.startsWith('window.')`,
or a `switch` on the literal) — the family-level `is*Action` guards were removed once no caller used them.

| Function | Purpose |
|----------|---------|
| `isWindowContentData(renderer, value)` | Validates data matches the renderer type (dispatches to the internal table / iframe / component shape checks) |
| `isContentUpdateOperationValid(renderer, op)` | Validates an update operation is legal for the renderer |
| `applyContentOperation(currentData, op)` | Applies a content update operation to existing data (shared by live window state and session restore) |

---

## Processing Pipeline

```
AI emits tool call → MCP tool creates OSAction
  → actionEmitter.emitAction(action) → BroadcastCenter
  → WebSocket ACTIONS event → Frontend store
  → applyAction() routes to slice handler
```

Actions are scoped by monitor. The store key format is `"monitorId/windowId"` (e.g., `"0/win-settings"`). If no `monitorId` is present in the action, it falls back to the active monitor.

Multiple synchronous actions are batched into a single Immer transaction. Async actions (`window.capture`, `desktop.updateSettings`, and both `user.clipboard.*`) run outside Immer.
