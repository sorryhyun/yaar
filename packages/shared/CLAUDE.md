# Shared Package

Shared types between frontend and server.

## Exports

- `actions.ts` - OS Actions DSL (includes `WindowState` with `appProtocol?: boolean`)
- `events.ts` - WebSocket event types
- `components.ts` - Component schemas, types, and type guards (Zod v4)
- `app-protocol.ts` - App Protocol types (manifest, state/command descriptors, postMessage protocol, `IFRAME_APP_PROTOCOL_SCRIPT`)

## OS Actions

The language AI uses to control the desktop.

**Window Actions:**
- `window.create` - Create window with bounds, content, title, variant
- `window.close`, `window.focus`, `window.minimize`, `window.maximize`, `window.restore`
- `window.move`, `window.resize`, `window.setTitle`, `window.setContent`
- `window.lock`, `window.unlock` - Prevent concurrent modifications
- `window.updateContent` - Diff-based updates (append, prepend, replace, insertAt, clear)
- `window.capture` - Capture window as PNG screenshot

**Notifications:**
- `notification.show`, `notification.dismiss`

**Toasts:**
- `toast.show`, `toast.dismiss`

**Dialogs:**
- `dialog.confirm` — modal confirmation with optional permission persistence

**User Prompts:**
- `user.prompt.show`, `user.prompt.dismiss` — ask/request dialogs (options + text input)

**App Actions:**
- `app.badge` — set badge count on desktop app icon

**Desktop Actions:**
- `desktop.refreshApps`, `desktop.createShortcut`, `desktop.removeShortcut`, `desktop.updateShortcut`

**Window Variants:** `standard` (default), `widget` (below standard), `panel` (fixed-position, no stacking)

**Content Renderers:** `markdown`, `table`, `html`, `text`, `iframe`, `component`

## WebSocket Events

**Client → Server:**
- `USER_MESSAGE` - User input with interaction history (optional `monitorId` for multi-monitor routing)
- `WINDOW_MESSAGE` - Message from specific window
- `COMPONENT_ACTION` - Interactive component action (with optional formData, actionId)
- `INTERRUPT`, `INTERRUPT_AGENT` - Stop agents
- `RESET` - Interrupt all, clear context, recreate main agent
- `SET_PROVIDER` - Switch AI provider
- `RENDERING_FEEDBACK` - Window content rendering status
- `DIALOG_FEEDBACK` - User response to approval dialog
- `TOAST_ACTION` - User dismisses reload toast (marks cache entry failed)
- `USER_PROMPT_RESPONSE` - User response to ask/request prompt
- `USER_INTERACTION` - Batch of user interactions (close, focus, move, resize, draw, etc.)
- `APP_PROTOCOL_RESPONSE` - Iframe app's response to an agent query/command
- `APP_PROTOCOL_READY` - Iframe app registered with the App Protocol
- `SUBSCRIBE_MONITOR` - Subscribe to events for a specific monitor
- `REMOVE_MONITOR` - Remove a background monitor

**Server → Client:**
- `ACTIONS` - Array of OS Actions (optional `monitorId`)
- `AGENT_THINKING`, `AGENT_RESPONSE` - AI output stream (with agentId, optional `monitorId`)
- `CONNECTION_STATUS` - connected/disconnected/error (includes `sessionId`, provider)
- `TOOL_PROGRESS` - Tool execution status (running/complete/error)
- `ERROR` - Error message (with optional agentId)
- `WINDOW_AGENT_STATUS` - Window agent lifecycle: assigned/active/released
- `MESSAGE_ACCEPTED`, `MESSAGE_QUEUED` - Queue notifications
- `APPROVAL_REQUEST` - Permission dialog for user approval
- `APP_PROTOCOL_REQUEST` - Agent requesting state/command from an iframe app

## Component DSL

Interactive components for `component` renderer. Flat array only — no nesting.

Component types: `button`, `input`, `select`, `text`, `badge`, `progress`, `image`

Layout via `ComponentLayout`: `{ components: Component[], cols?: number | number[], gap?: 'none'|'sm'|'md'|'lg' }`

## Adding a New OS Action

1. Define action type in `src/actions.ts`
2. Handle in `applyAction()` in `@yaar/frontend`
3. Add MCP tool in `@yaar/server` if needed

## Zod Schema Guidelines (v4)

This package uses Zod v4 for schema validation. Follow these patterns.

### Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Schema variable | `camelCaseSchema` | `buttonSchema` |
| Inferred type | `PascalCase` | `ButtonComponent` |
| Type guard | `isPascalCase` | `isButtonComponent` |

### Schema Organization

```typescript
import { z } from 'zod';

// 1. Leaf schemas first (non-recursive)
const buttonSchema = z.object({
  type: z.literal('button'),
  label: z.string().describe('Button text'),
  variant: z.enum(['primary', 'secondary']).optional(),
});

// 2. Recursive schemas use getter pattern (Zod v4)
const containerSchema = z.object({
  type: z.literal('container'),
  get children() {
    return z.array(componentSchema);
  },
});

// 3. Discriminated union on 'type' field
const componentSchema = z.discriminatedUnion('type', [
  buttonSchema,
  containerSchema,
]);

// 4. Infer types (single source of truth)
export type ButtonComponent = z.infer<typeof buttonSchema>;
export type Component = z.infer<typeof componentSchema>;

// 5. Export schemas for validation consumers
export { buttonSchema, componentSchema };
```

### Zod v4 Patterns

- **Recursive types**: Use getter pattern, not `z.lazy()`
- **Documentation**: Use `.describe()` for MCP tool docs
- **Top-level formats**: Prefer `z.email()`, `z.uuid()` over method chains
- **Error messages**: Use `{ error: "message" }` parameter

### Type Guards (Lightweight)

For frontend (no Zod dependency), export separate type guards:

```typescript
export function isComponent(v: unknown): v is Component {
  return typeof v === 'object' && v !== null && 'type' in v;
}
```

### Export Strategy

- **Frontend**: Import types + type guards (lighter bundle)
- **Server**: Import schemas for MCP tool validation