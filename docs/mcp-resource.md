# MCP Embedded Resources in Tool Results

YAAR tool results support **MCP Embedded Resource** blocks (`type: 'resource'`), giving the AI structured file metadata (URI, MIME type) alongside content instead of plain text.

## What Are Embedded Resources?

From the [MCP spec](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-result), tool results can include content blocks beyond plain text:

```jsonc
{
  "type": "resource",
  "resource": {
    "uri": "yaar://storage/apps/devtools/projects/abc123/src/main.ts",
    "text": "── src/main.ts (42 lines) ──\n 1│import ...",
    "mimeType": "text/typescript"
  }
}
```

The `uri` is a label the AI can reference later — it maps to the same `yaar://` URI scheme used by verb tools. The `mimeType` tells the AI what kind of file it's looking at.

## Where Resources Are Emitted

### Storage `read` verb

All text file reads via `read` on `yaar://storage/*` URIs return embedded resources:

```
read("yaar://storage/config/hooks.json")
→ { type: 'resource', resource: { uri: 'yaar://storage/config/hooks.json', text: '...', mimeType: 'application/json' } }
```

Images and PDFs still use `image` blocks via `okWithImages`.

### Devtools `readFile` command

Multi-file reads return one resource block per file:

```
command("readFile", { path: ["src/main.ts", "src/store.ts"] })
→ [
    { type: 'resource', resource: { uri: 'yaar://storage/apps/devtools/projects/{id}/src/main.ts', text: '...', mimeType: 'text/typescript' } },
    { type: 'resource', resource: { uri: 'yaar://storage/apps/devtools/projects/{id}/src/store.ts', text: '...', mimeType: 'text/typescript' } }
  ]
```

### Devtools `grep` command

Grep results are grouped by file, each as a resource block with matched lines:

```
command("grep", { pattern: "createSignal" })
→ [
    { type: 'resource', resource: { uri: 'yaar://storage/apps/devtools/projects/{id}/src/main.ts', text: '── src/main.ts (3 matches) ──\n12│...', mimeType: 'text/typescript' } },
    { type: 'resource', resource: { uri: 'yaar://storage/apps/devtools/projects/{id}/src/store.ts', text: '── src/store.ts (1 matches) ──\n5│...', mimeType: 'text/typescript' } }
  ]
```

## How It Works Internally

### Type chain

```
EmbeddedResourceBlock (handlers/uri-registry.ts)
  → VerbResult.content union includes { type: 'resource' }
  → MCP SDK ContentBlock already includes EmbeddedResource (v1.25.3+)
  → Agent SDK passes resource blocks through to Claude natively
```

### Key files

| File | Role |
|------|------|
| `packages/server/src/handlers/uri-registry.ts` | `EmbeddedResourceBlock` type, `VerbResult` union |
| `packages/server/src/handlers/utils.ts` | `okResource()` helper, `mimeFromPath()` |
| `packages/server/src/handlers/storage.ts` | Storage read returns resource blocks |
| `packages/server/src/features/window/app-protocol.ts` | `wrapAppValue()` accepts and truncates resource blocks |
| `packages/server/src/providers/claude/message-mapper.ts` | Extracts `resource.text` for frontend display |

### Helpers

```typescript
import { okResource, mimeFromPath } from './utils.js';

// Return a file as an embedded resource
okResource('yaar://storage/path/to/file.ts', fileContent, 'text/typescript');

// Infer MIME from extension
mimeFromPath('src/main.ts'); // → 'text/plain' (uses MIME_TYPES from config.ts)
```

### App protocol support

Apps can return resource blocks directly from command/query handlers. The `wrapAppValue()` function recognizes `type: 'resource'` blocks and applies the same 40KB truncation to `resource.text`.

```typescript
// In an app protocol handler:
return results.map((r) => ({
  type: 'resource',
  resource: {
    uri: `yaar://storage/apps/myapp/${r.path}`,
    text: r.content,
    mimeType: 'text/typescript',
  },
}));
```

## Level 1: Consistent Resource Blocks (Implemented)

All `read` verb handlers now return embedded resource blocks instead of plain `ok()`/`okJson()`. This gives every tool result URI provenance + MIME type.

### Helper

```typescript
okJsonResource(uri: string, data: object): VerbResult
// → okResource(uri, JSON.stringify(data, null, 2), 'application/json')
```

### Handlers converted

| Handler | URI pattern | MIME type |
|---------|-------------|-----------|
| config | `yaar://config/*` | `application/json` |
| session | `yaar://sessions/*` | `application/json` (JSON state) or `text/plain` (transcripts) |
| window | `yaar://windows/*` | `application/json` (metadata), `image/webp` unchanged for screenshots |
| apps | `yaar://apps/{id}` | `text/markdown` (SKILL.md) |
| apps | `yaar://apps/{id}/storage/*` | MIME inferred from extension |
| skills | `yaar://skills/{topic}` | `text/markdown` |
| agents | `yaar://sessions/current/agents/*` | `application/json` |
| storage | `yaar://storage/*` | already used `okResource()` |

`list` verbs and `invoke` results are unchanged — they still use `okJson()` and `ok()`.

---

## Level 2: ResourceLink for `list` (Plan)

Turn `list` verb results from inline JSON dumps into arrays of navigable `resource_link` blocks. The AI receives typed URI references it can selectively `read`.

### New type

```typescript
// In uri-registry.ts
interface ResourceLinkBlock {
  type: 'resource_link';
  resource: {
    uri: string;
    name?: string;        // display label (e.g. filename)
    description?: string; // one-line summary
    mimeType?: string;    // expected MIME if fetched
  };
}

// Add to VerbResult.content union
type ContentBlock = TextBlock | ImageBlock | EmbeddedResourceBlock | ResourceLinkBlock;
```

### New helper

```typescript
// In utils.ts
okLinks(links: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>): VerbResult
```

### Handlers to convert

| Handler | Current `list` return | Proposed change |
|---------|----------------------|-----------------|
| `yaar://config/` | `{ sections: ["yaar://config/settings", ...] }` | Array of resource_link with description per section |
| `yaar://storage/*` | `[{ path, isDirectory, size, modifiedAt }]` | resource_link per entry, URI = `yaar://storage/{path}`, name = filename |
| `yaar://windows` | `[{ id, uri, title, renderer, ... }]` | resource_link per window, URI = `yaar://windows/{id}`, name = title |
| `yaar://apps` | `[{ id, name, description, ... }]` | resource_link per app, URI = `yaar://apps/{id}`, name = app name |
| `yaar://sessions/` | `{ sessions: [{ sessionId, ... }] }` | resource_link per session |
| `yaar://skills` | `{ topics: ["components", ...] }` | resource_link per topic |
| `yaar://sessions/current/agents` | `{ totalAgents, ... }` | Keep as JSON (agent list is a summary, not navigable children) |

### Message mapper change

```typescript
// In message-mapper.ts — extend extractToolResult
if (item.type === 'resource_link' && typeof item.resource === 'object') {
  const res = item.resource as { uri?: string; name?: string };
  return `[${res.name ?? 'link'}](${res.uri})`;
}
```

### App protocol change

`wrapAppValue()` in `app-protocol.ts` needs to recognize `type: 'resource_link'` blocks and pass them through (no truncation needed — links are small).

### Migration strategy

1. Add `ResourceLinkBlock` type to `uri-registry.ts`
2. Add `okLinks()` helper to `utils.ts`
3. Convert `list` handlers one at a time (storage first — biggest win)
4. Update message mapper to render links as markdown refs
5. Update `wrapAppValue()` for app protocol

### Backward compatibility

Resource links are already part of the MCP SDK (`@modelcontextprotocol/sdk` v1.25.3+). The Claude Agent SDK passes them through natively. No SDK upgrade needed.

For the frontend message mapper, resource_link blocks that aren't recognized are silently ignored (filtered by `.filter(Boolean)`), so rolling out incrementally is safe.

---

## Level 3: URI-Aware Context Assembly (Draft)

Use resource block URIs to deduplicate content across tool results in long conversations.

### Problem

In a long session, the AI often reads the same file multiple times. Each read adds ~N KB to context. With resource blocks carrying URIs, the context system can detect duplicates.

### Proposed design

#### 3a. URI content index

Add a `ResourceIndex` to `ContextPool` that tracks URIs seen in tool results:

```typescript
class ResourceIndex {
  // URI → { hash, turnIndex, byteSize }
  private seen = new Map<string, { hash: string; turn: number; bytes: number }>();

  /** Record a resource block from a tool result. */
  track(uri: string, text: string, turn: number): void;

  /** Check if a URI was seen before and content hasn't changed. */
  isDuplicate(uri: string, text: string): { duplicate: boolean; turn: number } | null;
}
```

#### 3b. Context assembly integration

In `ContextAssemblyPolicy`, when building the prompt:

1. Scan tool_result messages for resource blocks
2. For each `{ type: 'resource', resource: { uri, text } }`:
   - Hash the text content
   - If same URI + same hash seen in an earlier turn → replace with stub:
     `{ type: 'text', text: '[already in context: yaar://storage/src/main.ts (turn 5)]' }`
   - If same URI + different hash → keep (file changed)
   - If new URI → track and keep
3. Track byte savings for monitoring

#### 3c. Invalidation

- **Same session**: When `invoke("yaar://storage/...", { action: "write" })` succeeds, evict the URI from the index
- **Window updates**: `invoke("yaar://windows/...", { action: "update" })` evicts the window URI
- **Config writes**: Same pattern for config invoke

This can hook into the existing `subscriptionRegistry.notifyChange(uri)` mechanism — `ResourceIndex` listens to the same notifications.

#### 3d. Scope and limits

- Only applies to `resource` blocks (not `text` or `image`)
- Only deduplicates within the same agent's context (not cross-agent)
- Min size threshold: only deduplicate blocks > 1KB (small blocks aren't worth the stub overhead)
- Max age: don't reference turns older than N (configurable, e.g. 50 turns back)

#### 3e. Key files to modify

| File | Change |
|------|--------|
| `agents/context-pool.ts` | Add `ResourceIndex` instance |
| `agents/context-pool-policies/context-assembly.ts` | Scan + deduplicate resource blocks during prompt assembly |
| `handlers/storage.ts` | Evict URI on write/edit |
| `handlers/window.ts` | Evict URI on update |
| `handlers/config.ts` | Evict URI on config write |

#### 3f. Open questions

- **Granularity**: Should dedup work at the full-file level, or per-line-range? (e.g., if `read` with `lines: "10-20"` returns a subset, that's a different "resource" than the full file)
- **Agent SDK passthrough**: Does the Agent SDK preserve resource block structure in conversation history, or flatten to text? If flattened, dedup must happen before the SDK sees the messages.
- **User control**: Should there be a way to force re-reading (bypass dedup)? Could use a `force: true` read option.

## Not Yet Implemented

- **Binary blobs** (`resource.blob`) — for non-text content embedded as base64
- **Frontend resource UI** — the frontend currently shows `resource.text` as plain text; could render file cards with URI/MIME metadata
