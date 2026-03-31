# Proposal: Expanding Session Observability, Caching, and Context Management

This proposal builds on the MCP resource block infrastructure (Levels 1-2, implemented) to address three gaps: invisible iframe app interactions, limited caching scope, and redundant context in long sessions.

## Current State: What Resource Blocks Enable

Every `read` verb now returns `EmbeddedResourceBlock`s with URI provenance and MIME type. Every `list` verb returns `ResourceLinkBlock`s — navigable URI references the AI can selectively `read`. The Claude Agent SDK preserves this structure natively; Claude sees the full `{ uri, text, mimeType }` in tool results.

**Key types** (in `handlers/uri-registry.ts`):
```typescript
interface EmbeddedResourceBlock {
  type: 'resource';
  resource: { uri: string; text: string; mimeType?: string };
}

interface ResourceLinkBlock {
  type: 'resource_link';
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}
```

**Helpers** (in `handlers/utils.ts`): `okResource()`, `okJsonResource()`, `okLinks()`, `mimeFromPath()`.

**Handlers converted**: storage, config, session, window, apps, skills, agents — all `read` verbs return resource blocks, all `list` verbs return resource links. `invoke` results and `list` on `agents` still use `ok()`/`okJson()`.

**App protocol support**: `wrapAppValue()` in `app-protocol.ts` recognizes both `resource` and `resource_link` blocks, applying 40KB truncation to resource text.

**Message mapper**: `extractToolResult()` in `message-mapper.ts` flattens resource blocks to text for frontend display (Claude sees the full structure; frontend sees plain text).

**Verb route envelope**: `toEnvelope()` in `verb.ts` extracts `resource.text` for iframe apps and preserves `resource_link` as structured objects.

---

## Gap 1: Invisible Iframe App Interactions

### Problem

The session logging system (`logging/session-logger.ts`) captures monitor/window agent interactions thoroughly — tool calls, tool results, OS actions, user interactions. But iframe app interactions are largely invisible:

| What | Logged? |
|------|---------|
| User messages to monitor agent | Yes |
| Agent tool calls (verb tools) | Yes |
| Agent tool results | Yes |
| OS actions (window ops) | Yes |
| Iframe verb calls (iframe → server) | Yes (request only, no response) |
| **App protocol requests (agent → iframe)** | **No** |
| **App protocol responses (iframe → agent)** | **No** |
| **App agent tool calls (query/command/relay)** | **No** |
| **App-scoped storage operations** | **No** |

### Impact

- Can't audit what happened inside an app during a session
- Can't correlate app agent decisions with monitor agent context
- Session restore can't recover app protocol state (only `WindowStateRegistry.appCommands` is persisted for reload replay)
- Debugging app agent behavior requires reproducing the interaction

### Proposed: Log App Protocol Interactions

Use the existing `SessionLogger` infrastructure to log app protocol exchanges as `tool_use`/`tool_result` pairs in per-agent JSONL files.

**Where to instrument**:
- `mcp/app-agent/index.ts` — the query/command/relay tool handlers. Add `logger.logToolUse()` before execution and `logger.logToolResult()` after.
- `http/routes/verb.ts` — add `logger.logToolResult()` for iframe verb responses (currently only logs the request).

**Log entry format** (fits existing JSONL schema):
```jsonc
// App agent queries app state
{ "type": "tool_use", "agentId": "app-devtools", "toolName": "query", "toolInput": { "stateKey": "manifest" } }
{ "type": "tool_result", "agentId": "app-devtools", "toolName": "query", "content": "{...}", "durationMs": 42 }

// App agent sends command
{ "type": "tool_use", "agentId": "app-devtools", "toolName": "command", "toolInput": { "command": "compile", "params": {...} } }
{ "type": "tool_result", "agentId": "app-devtools", "toolName": "command", "content": "OK", "durationMs": 1200 }
```

**Files to modify**:
- `mcp/app-agent/index.ts` — add logging calls in query/command/relay handlers
- `http/routes/verb.ts` — add `logToolResult()` after iframe verb response
- `logging/session-logger.ts` — no changes needed (existing API sufficient)

---

## Gap 2: Verb-Level Resource Dedup (Corrected Level 3)

### Problem

In long sessions, the AI reads the same file repeatedly. Each read adds the full content to the Agent SDK's conversation history, consuming tokens (cost) and context window space.

### Why the original Level 3 design doesn't work

The original design proposed deduplicating in `ContextAssemblyPolicy` during prompt assembly. This has a fundamental architecture mismatch:

- Tool results live in the **Claude Agent SDK's session history**, not in `ContextTape`
- `ContextTape` only stores user/assistant text messages
- `ContextAssemblyPolicy` builds the *next* user message; it cannot modify prior tool results
- YAAR resumes sessions via `resume: sessionId` — the SDK owns the conversation

### Corrected approach: intercept at verb execution

The `exec()` function in `handlers/index.ts` is the single chokepoint for all verb tool calls. A `ResourceIndex` on `LiveSession` tracks URI + content hash per agent. On repeated `read` calls for unchanged content, return a stub resource block instead of the full file.

```
Claude calls read("yaar://storage/src/main.ts")
  → exec() checks ResourceIndex
  → Same URI + same content hash as previous read?
    → YES: return stub resource block
    → NO: execute normally, track in index
```

**Stub content** (Claude sees this as a tool result):
```jsonc
{
  "type": "resource",
  "resource": {
    "uri": "yaar://storage/src/main.ts",
    "text": "[Content unchanged since previous read — 247 lines, text/typescript]",
    "mimeType": "text/plain"
  }
}
```

**Scope rules**:
- Only `read` verb with no `lines`/`pattern` options (filtered reads are already compact)
- Only content > 1KB (stub overhead not worth it for small results)
- Keyed per agent (each agent has its own conversation context)

**Invalidation**:
- `invoke` verb with write/edit/delete → invalidate the URI before execution
- `delete` verb → invalidate the URI
- Agent destroyed → clear that agent's entries
- Extend `subscriptionRegistry.notifyChange()` to storage and config writes (currently only app storage calls it)

**Files to modify**:
- New: `session/resource-index.ts` — `ResourceIndex` class
- `session/live-session.ts` — add `resourceIndex` field
- `handlers/index.ts` — check index on `read`, invalidate on `invoke`/`delete`
- `handlers/storage.ts` — add `subscriptionRegistry.notifyChange()` on write/delete
- `handlers/config.ts` — add `subscriptionRegistry.notifyChange()` on config writes

---

## Gap 3: Reload Cache Expansion

### Current state

The reload cache (`reload/cache.ts`) stores fingerprint → OS action sequence mappings. Fingerprints capture content hash + window state hash + n-grams. On similar future contexts, cached action sequences are offered as `<reload_options>` in the agent's prompt.

**What's cached**: OS actions only (window.create, setContent, etc.)
**What's NOT cached**: app protocol interactions, tool results, app state

### Proposed: App state in fingerprints

Include app state indicators in fingerprints so cache entries invalidate when app state changes:

```typescript
interface Fingerprint {
  // existing fields...
  appStateHash?: string; // Hash of app manifest version + key state indicators
}
```

This prevents stale cache hits when an app's internal state has diverged from what was cached.

### Proposed: App command sequences in cache entries

Currently `WindowStateRegistry.appCommands` records app protocol commands for reload replay. This could be unified with the reload cache:

```typescript
interface CacheEntry {
  // existing fields...
  appCommands?: AppProtocolRequest[]; // Commands to replay alongside OS actions
}
```

When a cached entry is replayed, both OS actions and app commands execute, restoring the full state.

---

## Open Questions

1. **Agent SDK context management** — Does the Claude Agent SDK already compress or truncate old tool results? If so, resource dedup's value is primarily token cost savings, not context window management.

2. **Per-agent vs per-session dedup** — Per-agent is semantically correct (each agent has its own conversation). Per-session could share a content-hash cache for disk I/O savings (orthogonal to context dedup).

3. **Stub confusion risk** — If a write happens outside the `invoke` verb path (e.g., app protocol command modifying state), the resource index won't invalidate. Mitigation: invalidate on any `invoke` to the same URI prefix.

4. **Logging volume** — App protocol logging adds JSONL entries for every query/command. For high-frequency apps (e.g., devtools with many compiles), this could be significant. Consider: log at info level with optional verbose flag.

5. **Cache scope** — Should reload cache expansion (app commands in entries) be a separate cache, or extend the existing `CacheEntry` type? Extending is simpler but increases entry size.
