# Shared Package

Shared types between frontend and server.

## Exports

- `actions.ts` - OS Actions DSL (includes `WindowState` with `appProtocol?: boolean`), plus the runtime validation helpers `isWindowContentData` / `isContentUpdateOperationValid` / `applyContentOperation`
- `events.ts` - WebSocket event types, `ClientEventType`/`ServerEventType` constants
- `component-types.ts` - The Zod-free half of the Component DSL: enum value lists (`GAP_VALUES`, `BUTTON_VARIANTS`, …), the narrow renderer-facing types, `isComponent`. This is what the barrel exports.
- `components.ts` - The Zod half: `componentSchema`, `componentLayoutSchema`, `displayContentSchema`, and the inferred `ComponentLayout` / `DisplayContent`
- `schemas.ts` - The `@yaar/shared/schemas` entry point: every Zod-bearing export (component schemas + the whole bridge contract), kept off the barrel so the frontend does not bundle Zod
- `app-protocol.ts` - App Protocol types (manifest, state/command descriptors, postMessage protocol, `IFRAME_APP_PROTOCOL_SCRIPT`), plus `listKeybindingIssues` — the one exported keybinding entry point, shared by both protocol readers (combo normalization and the reserved-combo set are internal to it)
  - Five request kinds: `manifest`, `query`, `command`, `eval`, and `describe`. The last documents
    **one** state key or command (`AppDescribeRequest`/`AppDescribeResponse`, `APP_MSG.describe*`)
    from an optional `describe()` the app attaches to that entry. `doc: null` is a real answer —
    the key exists and the app defines no `describe()` for it, so the server falls back to the
    manifest's static `description`; only a key that is absent is an error. It is answered on
    demand and never folded into the manifest, or the cheapest call would pay for every key.
  - A command's `params` JSON Schema is **enforced** by the iframe bridge before the handler
    runs: a missing `required` key or a key absent from `properties` is rejected naming both
    the wrong keys and the accepted ones. `additionalProperties: true` opts a pass-through
    command out; a command that declares no `properties` stays free-form. The schema was
    previously advisory, so an undeclared key was dropped in silence and the handler failed
    later with a message about its own logic (devtools' `copyFile` called with
    `{source, destination}` reported "Source and destination are the same path").
- `yaar-uri.ts` - Shared URI utilities: `parseYaarUri`, `buildYaarUri`, `isYaarUri`, `resolveContentUri`, `extractAppId`, `parseFileUri`, `parseBareWindowUri`, `expandBraceUri`, plus the devtools preview identity helpers (`PREVIEW_APP_PREFIX`, `previewAppId`, `isPreviewAppId`)
- `iframe-scripts/` - Inline JS scripts injected into iframes (capture, fetch-proxy, contextmenu, verb-sdk, windows-sdk, storage-sdk, notifications-sdk)

## OS Actions

The language AI uses to control the desktop. Defined in `src/actions.ts`.

Window actions (create, close, focus, minimize, maximize, restore, move, resize, setTitle, setContent, updateContent, lock, unlock, capture), notifications (show, dismiss), toasts (show, dismiss), dialogs (confirm), user prompts (show, dismiss), app badge, desktop actions (refreshApps, createShortcut, removeShortcut, updateShortcut).

**Window Variants:** `standard` (default), `widget` (below standard), `panel` (fixed-position, no stacking)

**Content Renderers:** `markdown`, `table`, `html`, `text`, `iframe`, `component`

## WebSocket Events

See `src/events.ts` for full Client→Server and Server→Client event types.

`UserMessageEvent` carries an optional `target?: 'monitor' | 'session'` (default `'monitor'`): set
to `'session'` by the CLI-panel toggle to route the message to the session agent (the user's
deputy, which can drive the real browser via `yaar://session/browser`) instead of the monitor
agent.

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
| Type guard | `isPascalCase` | `isComponent` |

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

Two entry points, and the split is enforced by what each file imports rather than by convention:

- **`@yaar/shared`** (the barrel) — types, enum value lists, lightweight guards. Imports no Zod, so
  the frontend bundle carries none. It re-exports schema-*inferred* types (`ComponentLayout`,
  `DisplayContent`, `Bridge*`) with `export type`, which is erased at emit.
- **`@yaar/shared/schemas`** — every Zod value: the component/display schemas and the whole
  extension-bridge contract. Imported only by the server (MCP tool validation, bridge frame parsing).

Adding a schema to the barrel silently re-adds ~100KB of Zod to the browser bundle. The check is
`grep -c zod packages/frontend/dist/main-*.js` after a build — it should stay at 0.

- **Frontend**: Import types + type guards (lighter bundle)
- **Server**: Import schemas from `@yaar/shared/schemas` for MCP tool validation