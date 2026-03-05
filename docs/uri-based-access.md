# URI-Based Resource Addressing

YAAR uses a unified `yaar://` URI scheme to address all internal resources — apps, storage files, sandboxes, and windows. The scheme is implicitly scoped to the current session — `yaar://` *is* the session root.

```
yaar://                          → session (implicit root)
yaar://apps/{appId}              → app
yaar://storage/{path}            → storage file
yaar://sandbox/{id}/{path}       → sandbox file
yaar://{monitorId}/{windowId}    → window
```

---

## URI Format

```
yaar://{authority}/{path}
```

### Content Resources

| Authority | Example | Resolves to |
|-----------|---------|-------------|
| `apps` | `yaar://apps/excel-lite` | `/api/apps/excel-lite/index.html` |
| `apps` | `yaar://apps/excel-lite/index.html` | `/api/apps/excel-lite/index.html` |
| `storage` | `yaar://storage/documents/report.pdf` | `/api/storage/documents/report.pdf` |
| `sandbox` | `yaar://sandbox/17123456/src/main.ts` | `/api/sandbox/17123456/src/main.ts` |

For `yaar://apps/{appId}` (no subpath), the default entry point `index.html` is appended automatically.

### File-Operation URIs

The `basic/` MCP tools (`read`, `write`, `list`, `delete`, `edit`) use `parseFileUri()` from `@yaar/shared` to parse file-operation URIs:

| URI | Meaning |
|-----|---------|
| `yaar://storage/docs/file.txt` | Persistent storage file |
| `yaar://sandbox/123/src/main.ts` | Existing sandbox file |
| `yaar://sandbox/new/src/main.ts` | New sandbox (write/edit only) |

Legacy `storage://` and `sandbox://` schemes are also accepted by `parseFileUri()` for backward compatibility with existing AI context.

### Window Addressing

Windows are internally keyed as `{monitorId}/{windowId}`, which maps naturally to the URI scheme:

```
yaar://{monitorId}/{windowId}
```

| Example | Meaning |
|---------|---------|
| `yaar://monitor-0/win-storage` | The storage window on the default monitor |
| `yaar://monitor-1/win-excel` | The excel window on monitor 1 |

This is the same format used by `scopedKey()` (server) and `toWindowKey()` (frontend) for window state lookups. The `yaar://` prefix formalizes it as a URI — today this is used internally for keying; in the future it could extend to address app state and commands:

```
yaar://monitor-0/win-excel/state/cells/A1    -> read cell value (future)
yaar://monitor-0/win-excel/commands/save      -> execute command (future)
```

This extension would give the current `app_query` / `app_command` tools a URI-addressable substrate, enabling REST-style routing through window resources.

---

## Where URIs Are Used

### Window Content

The AI uses yaar:// URIs in the `create` tool's `content` parameter:

```
create({
  windowId: "excel-lite",
  title: "Excel Lite",
  renderer: "iframe",
  content: "yaar://apps/excel-lite"
})
```

The server resolves the URI to an API path before sending the action to the frontend. Storage files work the same way:

```
create({
  windowId: "report",
  title: "Q4 Report",
  renderer: "iframe",
  content: "yaar://storage/reports/q4.pdf"
})
```

### Desktop Shortcuts

Shortcuts use yaar:// URIs as their `target`:

```json
{
  "id": "app-excel-lite",
  "label": "Excel Lite",
  "icon": "📊",
  "target": "yaar://apps/excel-lite",
  "createdAt": 1709600000000
}
```

The URI itself communicates what the shortcut points to — `extractAppId()` parses app identity from the target.

### App Discovery API

The `/api/apps` endpoint returns `run` fields as yaar:// URIs:

```json
{
  "id": "excel-lite",
  "name": "Excel Lite",
  "run": "yaar://apps/excel-lite",
  ...
}
```

Apps with custom `run` paths in `app.json` (e.g., `"run": "index.html"`) get `yaar://apps/{appId}/index.html`. Absolute paths (starting with `/`) are returned as-is.

---

## Resolution

### Content Resolution

Content URIs are resolved via `resolveContentUri()` in `@yaar/shared`:

```typescript
import { resolveContentUri } from '@yaar/shared';

resolveContentUri('yaar://apps/excel-lite')
// -> '/api/apps/excel-lite/index.html'

resolveContentUri('yaar://storage/docs/file.txt')
// -> '/api/storage/docs/file.txt'

resolveContentUri('yaar://sandbox/123/src/main.ts')
// -> '/api/sandbox/123/src/main.ts'
```

Resolution points:
- **Server** (`mcp/window/create.ts`): resolves URIs in iframe content before emitting OS actions
- **Frontend** (`lib/api.ts`): `resolveAssetUrl()` resolves URIs and adds remote-mode auth

### Reverse Resolution (API path → parsed)

`parseContentPath()` parses API pathnames back into structured objects. Used by HTTP route handlers to unify routing for all content types:

```typescript
import { parseContentPath } from '@yaar/shared';

parseContentPath('/api/storage/docs/file.txt')
// -> { authority: 'storage', path: 'docs/file.txt' }

parseContentPath('/api/sandbox/123/src/main.ts')
// -> { authority: 'sandbox', sandboxId: '123', path: 'src/main.ts' }

parseContentPath('/api/apps/dock/index.html')
// -> { authority: 'apps', appId: 'dock', path: 'index.html' }
```

Returns `ParsedContentPath` — a union of `storage`, `sandbox`, and `apps` variants. App IDs are validated as kebab-case (`/^[a-z][a-z0-9-]*$/`).

### File-Operation Parsing

File-operation URIs are parsed via `parseFileUri()` in `@yaar/shared`. This is separate from `parseContentPath()` — it handles `yaar://` URIs (not API paths) and includes sandbox creation (`sandboxId: null`):

```typescript
import { parseFileUri, buildFileUri } from '@yaar/shared';

parseFileUri('yaar://storage/docs/file.txt')
// -> { authority: 'storage', path: 'docs/file.txt' }

parseFileUri('yaar://sandbox/123/src/main.ts')
// -> { authority: 'sandbox', sandboxId: '123', path: 'src/main.ts' }

parseFileUri('yaar://sandbox/new/src/main.ts')
// -> { authority: 'sandbox', sandboxId: null, path: 'src/main.ts' }

buildFileUri('storage', 'docs/file.txt')
// -> 'yaar://storage/docs/file.txt'

buildFileUri('sandbox', '123', 'src/main.ts')
// -> 'yaar://sandbox/123/src/main.ts'

buildFileUri('sandbox', null, 'src/main.ts')
// -> 'yaar://sandbox/new/src/main.ts'
```

The `basic/` MCP tools use `parseFileUri()` via a thin adapter in `mcp/basic/uri.ts`.

### Content Helpers

```typescript
import { parseYaarUri, buildYaarUri, extractAppId, isYaarUri } from '@yaar/shared';

parseYaarUri('yaar://apps/storage')
// -> { authority: 'apps', path: 'storage' }

buildYaarUri('apps', 'excel-lite')
// -> 'yaar://apps/excel-lite'

extractAppId('yaar://apps/excel-lite')
// -> 'excel-lite'

isYaarUri('yaar://apps/excel-lite')
// -> true
```

### Window Helpers

```typescript
import { buildWindowUri, parseWindowUri } from '@yaar/shared';

buildWindowUri('monitor-0', 'win-storage')
// -> 'yaar://monitor-0/win-storage'

parseWindowUri('yaar://monitor-0/win-storage')
// -> { monitorId: 'monitor-0', windowId: 'win-storage' }
```

---

## Key Files

| File | Role |
|------|------|
| `packages/shared/src/yaar-uri.ts` | URI parser, builder, resolver (content, file, window), `ParsedContentPath` |
| `packages/server/src/http/routes/files.ts` | HTTP routes using `parseContentPath()` for apps, storage, sandbox |
| `packages/server/src/mcp/basic/uri.ts` | Thin adapter over `parseFileUri()` for basic MCP tools |
| `packages/server/src/mcp/window/create.ts` | Server-side URI resolution for iframe content |
| `packages/server/src/mcp/apps/discovery.ts` | `run` field and icon path generation as yaar:// URIs |
| `packages/server/src/storage/shortcuts.ts` | Shortcut creation with yaar:// targets |
| `packages/frontend/src/lib/api.ts` | Frontend URI resolution + remote auth |
| `packages/frontend/src/components/desktop/DesktopIcons.tsx` | Shortcut click handling via `extractAppId()` |
