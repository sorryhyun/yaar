# Shared Package

Shared types between frontend and server.

## Exports

- `actions.ts` - OS Actions DSL
- `events.ts` - WebSocket event types
- `components.ts` - Component schemas, types, and type guards (Zod v4)

## OS Actions

The language AI uses to control the desktop.

**Window Actions:**
- `window.create` - Create window with bounds, content, title, preset
- `window.close`, `window.focus`, `window.minimize`, `window.maximize`, `window.restore`
- `window.move`, `window.resize`, `window.setTitle`, `window.setContent`
- `window.lock`, `window.unlock` - Prevent concurrent modifications
- `window.updateContent` - Diff-based updates (append, prepend, replace, insertAt, clear)

**Notifications:**
- `notification.show`, `notification.dismiss`

**Window Presets:** `default`, `info`, `alert`, `document`, `sidebar`, `dialog`

**Content Renderers:** `markdown`, `table`, `html`, `text`, `iframe`, `component`

## WebSocket Events

**Client → Server:**
- `USER_MESSAGE` - User input with interaction history
- `WINDOW_MESSAGE` - Message from specific window
- `INTERRUPT`, `INTERRUPT_AGENT` - Stop agents
- `SET_PROVIDER` - Switch AI provider
- `RENDERING_FEEDBACK` - Window content rendering status
- `COMPONENT_ACTION` - Interactive component action

**Server → Client:**
- `ACTIONS` - Array of OS Actions
- `AGENT_THINKING`, `AGENT_RESPONSE` - AI output stream
- `CONNECTION_STATUS` - connected/disconnected/error
- `TOOL_PROGRESS` - Tool execution status
- `WINDOW_AGENT_STATUS` - Window agent lifecycle
- `MESSAGE_ACCEPTED`, `MESSAGE_QUEUED` - Queue notifications

## Component DSL

Interactive components for `component` renderer:
- Layout: `stack`, `grid`
- Container: `form`, `list`
- Input: `button`, `input`, `textarea`, `select`
- Display: `text`, `image`, `markdown`, `badge`, `progress`, `alert`, `divider`, `spacer`

## Adding a New OS Action

1. Define action type in `src/actions.ts`
2. Handle in `applyAction()` in `@claudeos/frontend`
3. Add MCP tool in `@claudeos/server` if needed

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