# Shared Package

Shared types between frontend and server.

## Exports

- `actions.ts` - OS Actions DSL (includes `WindowState` with `appProtocol?: boolean`)
- `events.ts` - WebSocket event types, `ClientEventType`/`ServerEventType` constants, `formatCompactInteraction()`
- `components.ts` - Component schemas, types, type guards (Zod v4), `DisplayContent`/`displayContentSchema`
- `app-protocol.ts` - App Protocol types (manifest, state/command descriptors, postMessage protocol, `IFRAME_APP_PROTOCOL_SCRIPT`)
- `iframe-scripts/` - Inline JS scripts injected into iframes (capture, fetch-proxy, contextmenu, verb-sdk, windows-sdk, storage-sdk, notifications-sdk)

## OS Actions

The language AI uses to control the desktop. Defined in `src/actions.ts`.

Window actions (create, close, focus, minimize, maximize, restore, move, resize, setTitle, setContent, updateContent, lock, unlock, capture), notifications (show, dismiss), toasts (show, dismiss), dialogs (confirm), user prompts (show, dismiss), app badge, desktop actions (refreshApps, createShortcut, removeShortcut, updateShortcut).

**Window Variants:** `standard` (default), `widget` (below standard), `panel` (fixed-position, no stacking)

**Content Renderers:** `markdown`, `table`, `html`, `text`, `iframe`, `component`

## WebSocket Events

See `src/events.ts` for full Client→Server and Server→Client event types.

## Component DSL

Interactive components for `component` renderer. Flat array only — no nesting.

Component types: `button`, `input`, `select`, `text`, `badge`, `progress`, `image`

Layout via `ComponentLayout`: `{ components: Component[], cols?: number | number[], gap?: 'none'|'sm'|'md'|'lg' }`

`DisplayContent` / `displayContentSchema` — non-component content schema for `create_window`/`update_window` MCP tools. Renderer: `markdown | html | text | iframe | table`. Content is a string or `{ headers, rows }` for table.

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
const buttonSchema = z.object({          // 1. Leaf schemas first
  type: z.literal('button'),
  label: z.string().describe('Button text'),
});
const containerSchema = z.object({       // 2. Recursive: getter pattern (not z.lazy())
  type: z.literal('container'),
  get children() { return z.array(componentSchema); },
});
const componentSchema = z.discriminatedUnion('type', [buttonSchema, containerSchema]); // 3. Union
export type Component = z.infer<typeof componentSchema>;  // 4. Infer types
export { buttonSchema, componentSchema };                 // 5. Export schemas
```

### Zod v4 Patterns

- **Recursive types**: Use getter pattern, not `z.lazy()`
- **Documentation**: Use `.describe()` for MCP tool docs
- **Top-level formats**: Prefer `z.email()`, `z.uuid()` over method chains
- **Error messages**: Use `{ error: "message" }` parameter
- **Type guards**: For frontend (no Zod dep), export lightweight guards: `isComponent(v): v is Component`

### Export Strategy

- **Frontend**: Import types + type guards (lighter bundle)
- **Server**: Import schemas for MCP tool validation