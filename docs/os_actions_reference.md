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
| `variant` | `'standard' \| 'widget' \| 'panel'` | no | Window layer (default: `'standard'`). Widgets sit below standard windows; panels are fixed-position. |
| `dockEdge` | `'top' \| 'bottom'` | no | Dock edge for panel variant |
| `frameless` | `boolean` | no | Hide the titlebar |
| `windowStyle` | `Record<string, string \| number>` | no | Custom CSS styles on the window element |
| `minimized` | `boolean` | no | Create in minimized state |
| `requestId` | `string` | no | Tracking ID for iframe load feedback |

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
| `'append'` | `data: string` | markdown, html, text | Append text to content |
| `'prepend'` | `data: string` | markdown, html, text | Prepend text to content |
| `'insertAt'` | `data: string`, `position: number` | markdown, html, text | Insert text at character position |
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
| `requestId` | `string` | no |

Async operation. For iframes, uses a three-tier strategy: (1) iframe self-capture via postMessage, (2) html2canvas on iframe content document, (3) html2canvas on the window frame. Returns base64 PNG via `RENDERING_FEEDBACK`.

---

## Notification Actions

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

**PermissionOptions:**

| Field | Type | Description |
|-------|------|-------------|
| `showRememberChoice` | `boolean` | Show "Remember my choice" checkbox |
| `toolName` | `string` | Tool name for saving the decision |
| `context` | `string?` | Optional context identifier |

The user's response is sent back to the server as a `DIALOG_FEEDBACK` event. If `permissionOptions` is set and the user checks "remember", the decision is persisted to `config/permissions.json`.

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
| `type` | `'file' \| 'url' \| 'action'` | What the shortcut opens |
| `target` | `string` | Storage path, URL, or action ID |
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

**button**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'button'` | yes | |
| `label` | `string` | yes | Button text |
| `action` | `string` | yes | Message sent to agent on click |
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
| `name` | `string` | yes | Field name in form data |
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
| `name` | `string` | yes | Field name in form data |
| `options` | `{ value: string; label: string }[]` | yes | |
| `formId` | `string` | no | |
| `label` | `string` | no | |
| `defaultValue` | `string` | no | |
| `placeholder` | `string` | no | |
| `disabled` | `boolean` | no | |

**text**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'text'` | yes | |
| `content` | `string` | yes | Text content |
| `variant` | `'body' \| 'heading' \| 'subheading' \| 'caption' \| 'code'` | no | |
| `color` | `'default' \| 'muted' \| 'accent' \| 'success' \| 'warning' \| 'error'` | no | |
| `textAlign` | `'left' \| 'center' \| 'right'` | no | |

**badge**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'badge'` | yes | |
| `label` | `string` | yes | |
| `variant` | `'default' \| 'success' \| 'warning' \| 'error' \| 'info'` | no | |

**progress**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'progress'` | yes | |
| `value` | `number` | yes | 0–100 |
| `label` | `string` | no | |
| `variant` | `'default' \| 'success' \| 'warning' \| 'error'` | no | |
| `showValue` | `boolean` | no | Show percentage text |

**image**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'image'` | yes | |
| `src` | `string` | yes | Source URL |
| `width` | `number \| string` | no | Width in px or CSS value |
| `height` | `number \| string` | no | Height in px or CSS value |
| `fit` | `'contain' \| 'cover' \| 'fill'` | no | Object fit mode |

---

## Union Type

All actions are represented by the `OSAction` union:

```typescript
type OSAction =
  | WindowAction
  | NotificationAction
  | ToastAction
  | DialogAction
  | AppAction
  | DesktopAction;
```

## Type Guards

| Function | Checks |
|----------|--------|
| `isWindowAction(action)` | `type` starts with `'window.'` |
| `isNotificationAction(action)` | `type` starts with `'notification.'` |
| `isToastAction(action)` | `type` starts with `'toast.'` |
| `isDialogAction(action)` | `type` starts with `'dialog.'` |
| `isAppAction(action)` | `type` starts with `'app.'` |

## Validation Helpers

| Function | Purpose |
|----------|---------|
| `isTableContentData(value)` | Checks `{ headers: string[], rows: string[][] }` shape |
| `isIframeContentData(value)` | Checks for URL string or `{ url, sandbox? }` object |
| `isComponentLayout(value)` | Checks for `{ components: [...] }` shape |
| `isWindowContentData(renderer, value)` | Validates data matches the renderer type |
| `isContentUpdateOperationValid(renderer, op)` | Validates an update operation is legal for the renderer |

---

## Processing Pipeline

```
AI emits tool call → MCP tool creates OSAction
  → actionEmitter.emitAction(action) → BroadcastCenter
  → WebSocket ACTIONS event → Frontend store
  → applyAction() routes to slice handler
```

Actions are scoped by monitor. The store key format is `"monitorId/windowId"` (e.g., `"monitor-0/win-settings"`). If no `monitorId` is present in the action, it falls back to the active monitor.

Multiple synchronous actions are batched into a single Immer transaction. Async actions (`window.capture`) run outside Immer.
