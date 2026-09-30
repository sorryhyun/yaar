# URI & Verb Reference

Precise reference for the `yaar://` URI scheme and the five generic verbs. For the design rationale — why URIs, why five verbs — see [URI-Based Resource Addressing](../architecture/verbalized-with-uri.md).

All parsing flows through `packages/shared/src/yaar-uri.ts`. Server-side handler registration lives in `packages/server/src/handlers/` (one file per namespace), registered into the `ResourceRegistry` in `handlers/uri-registry.ts`.

---

## URI Space

The `YaarAuthority` type covers ten namespaces:

| Namespace | URI | Description |
|-----------|-----|-------------|
| `apps` | `yaar://apps/{appId}` | App content (resolved to iframe URL), app storage, app DB, an app's own sub-agents |
| `storage` | `yaar://storage/{path}` | Persistent storage file |
| `windows` | `yaar://windows/{windowId}` | Windows (monitor inferred from agent context) |
| `config` | `yaar://config/...` | Settings, hooks, shortcuts, mounts, app credentials |
| `session` | `yaar://session/...` | Session info, agents, monitors, logs, context, browser |
| `user` | `yaar://user/...` | Notifications, prompts |
| `history` | `yaar://history/` | Past session logs (list/read) |
| `skills` | `yaar://skills/{topic}` | YAAR-specific how-to notes; `list` says when each topic applies |
| `mcp` | `yaar://mcp/...` | External MCP server gateway (add/remove/refresh servers, OAuth `login`/`logout`, call their tools) |
| `system` | `yaar://system/update` | The running installation — version check and self-update |

### Apps — `yaar://apps/{appId}`

The **installed** app. (The *running* instance is `yaar://windows/{windowId}` — see below.)

| Verb | URI | Effect |
|------|-----|--------|
| `list` | `yaar://apps` | Every installed app, as resource links |
| `describe` | `yaar://apps/{appId}` | The app's manual: name/description/icon, the section headings of `agent/SKILL.md` when it ships one (the manual itself is `read('yaar://apps/{appId}/skill')`, markdown), permissions, the **names** of its state keys and commands with the URIs that serve them in full, plus this door's `verbs`, `invokeActions`, and `subPaths`. `persona:*` commands are filtered out — they are a sub-agent's half of the protocol, written for a character rather than an operator |
| `read` | `yaar://apps/{appId}` | The app's effective manifest: id, name, kind, source, version, author, `isCompiled`, `hasProtocol`, `hasConfig`, permissions, `bundles`, `controls`, `subagents`, `streams`, `messaging`, `variant`, `dockEdge` |
| `invoke` | `yaar://apps/{appId}` | `set_badge`, `install`, `publish`, `publish_prepare`, `publish_confirm`, `publish_cancel`, `clone` — the enum and `describe`'s `invokeActions` are both derived from the table that dispatches them |
| `delete` | `yaar://apps/{appId}` | Uninstall |
| `list` | `yaar://apps/{appId}` | Not a collection — an app's addressable children are its `protocol`, `storage/`, `db/`, and `agents/` sub-paths |

#### The protocol — `yaar://apps/{appId}/protocol`

The compiled `dist/protocol.json` of the **installed** app, addressable at its own granularity (a 52-command app's manifest is ~42 KB, past the size at which the Claude CLI swaps a tool result for a disk path a monitor agent cannot open). Each verb answers its own question and the caller picks the size:

| Verb | URI | Effect |
|------|-----|--------|
| `describe` | `…/protocol` | What the document is: counts, byte size, and the doors below. Never grows with the app |
| `list` | `…/protocol` | **The index** — one resource link per state key and command, each carrying its rendered signature and the first sentence of its description. ~8 KB for 52 commands. Start here |
| `read` | `…/protocol` | The manifest verbatim, `$defs` included. The one large answer, and only on request |
| `read` | `…/protocol/commands/{name}` | One command, **self-contained**: signature, full description, `params`/`returns` carrying the `$defs` they reference, and a rendered call example. Brace-batchable: `…/commands/{a,b,c}` |
| `read` | `…/protocol/state/{key}` | One state key's documentation (its *value* is `read('yaar://windows/{windowId}/state/{key}')`) |
| `list` | `…/protocol/{commands,state}` | The index, narrowed to one section |
| `invoke`/`delete` | any `…/protocol` path | Refused — a protocol is documentation, and a command needs a running window to act on |

Serving `protocol.json` is safe because it is a build artifact (compiler writes it from the source AST; deploy re-derives and diffs it), so it cannot drift from the code.

This is the app **as compiled**. A running instance registers its protocol live and may not agree (a devtools preview routinely does not) — that instance's manual is `describe('yaar://windows/{windowId}')`.

`read`'s `subagents` and `streams` are **post-grant** — the intersection of the manifest with what the user approved at install (`config/app-grants.json`), not what `app.json` declares. An app holding `yaar-dev` can rewrite its own manifest, so the declaration is a request and the grant is the ceiling.

> `yaar://apps/{appId}/state/…` and `/commands/…` are **refused on every verb**, by name: protocol
> state has no value and a command has nothing to act on until a window is open, and the same app
> open on two monitors is two states. Use `yaar://windows/{windowId}/{state,commands}/{key}`.
> `storage/`, `db/`, and `agents/` keep all five verbs (`appStorage` and `appDb` are built on them),
> and `…/protocol/commands/{key}` is documentation, not an exception. Any other sub-path
> (`yaar://apps/{appId}/hamsters`) is refused too.

Handlers: `packages/server/src/handlers/apps/` (`register.ts` is the one composite registration —
`ResourceRegistry` has no middle wildcard).

### App sub-agents — `yaar://apps/self/agents`

An app's own sub-agents ("personas") — AI instances whose system prompt the app supplies at
runtime, each a real provider session with its own conversation memory. **Callable only from the
app's own iframe** (`POST /api/verb`), never by an agent and never by another app: the appId in
the URI must equal the appId the calling context says the caller is. Requires
`"subagents": { "max": N }` in `app.json` — honored
as written for a bundled app, and for an installed one only as far as the user approved at install
(`config/app-grants.json`, which caps `max` rather than merely enabling it).
The `yaar://apps/self/storage/`, `yaar://apps/self/db/`, and `yaar://apps/self/agents/`
subtrees are auto-granted (`SELF_GRANTS` in `http/iframe-tokens.ts`) — no `permissions` entry
needed for those specifically. (Other `apps/self/...` resources, and the app resource itself,
are not auto-granted.)

For the invariants these obey see [The Agent Tree](../architecture/monitor_and_windows_guide.md#the-four-laws); for the
how-to see the [YAAR SDK Guide](../guides/yaar_sdk.md#sub-agents-personas).
Handler: `packages/server/src/handlers/apps/agents-resource.ts`.

| Verb | URI | Effect |
|------|-----|--------|
| `list` | `yaar://apps/self/agents` | `{ max, personas: [...] }` — the roster |
| `read` | `yaar://apps/self/agents` | Same as `list` |
| `read` | `yaar://apps/self/agents/{personaId}` | One sub-agent's status + last answer |
| `invoke` | `yaar://apps/self/agents` | `{ action: 'spawn', ... }` (see below) |
| `invoke` | `yaar://apps/self/agents/{personaId}` | `{ action: 'message', content }` or `{ action: 'interrupt' }` |
| `delete` | `yaar://apps/self/agents/{personaId}` | Dispose one → `{ personaId, disposed: 1 }` |
| `delete` | `yaar://apps/self/agents` | Dispose all → `{ disposed: N }` |

**`spawn`** — idempotent: an existing `personaId` comes back with `reused: true` and its prompt
**unchanged** (the prompt is replayed every turn, so rewriting it under a live conversation would
rewrite who the persona has been all along; delete and respawn to recast).

| Field | Type | Notes |
|-------|------|-------|
| `personaId` | `string` | Required. `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` |
| `systemPrompt` | `string` | Required, used verbatim. Max 20 000 chars |
| `tools` | `ToolSpec[]` | Optional. Omit for a tool-less sub-agent |
| `model` | `string` | Optional model override |

A `ToolSpec` is `{ name, description, input?: { param: "string" \| "number" \| "boolean" \| "object" \| "array" } }`.
`name` and param names match `[A-Za-z][A-Za-z0-9_]{0,47}`. Limits: 12 tools,
6 000 chars across all names/descriptions/param descriptions (they are replayed every turn).
Calling a tool dispatches the app-protocol command `persona:{name}` to the app's own active
window on its own monitor, with `personaId` stamped into the params **last** so it wins over a
forged argument of the same name; whatever the handler returns becomes the tool result. No open
window is a tool *error*, not a dead turn — and never launches a window.

**Response shape** (same from `list`, `read`, and `spawn`):

| Field | Notes |
|-------|-------|
| `personaId` | The wire spelling of the pool's `subId` |
| `instanceId` | Agent instance id |
| `streamUri` | `yaar://agents/{instanceId}/stream` |
| `busy` | Whether a turn is in flight |
| `createdAt` | Timestamp |
| `model`, `tools`, `lastResponse` | Present only when set (`tools` is names only) |
| `turn` | The most recent turn, absent before the first `message`: `{ taskId, state, startedAt, endedAt?, error?, errorCode? }`. `state` is `running`, `completed`, `interrupted`, or `error`; on `error`, `error` is the reason in prose and `errorCode` the provider's own discriminant when it gave one (`error_max_turns`, `contextWindowExceeded`, …) |
| `usage` | Lifetime tokens: `{ inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, costUsd? }` — the same figures as the stream's `usage` frame. Not how full the context is |
| `contextWindow` | The model's context window in tokens, once the provider has stated it |

**`message`** returns as soon as the turn is queued (`{ taskId, personaId, instanceId, streamUri }`),
so N sub-agents generate concurrently. It **rejects rather than queues** when the target is
mid-turn: the error carries `structuredContent: { busy: true, personaId }` so the caller can
branch without parsing the sentence. The answer arrives on `streamUri` — frame kinds `start`,
`text`, `thinking`, `tool`, `usage`, `done` (carries the turn's final text), `error` — which
requires `"streams": ["agents"]` in `app.json`. `read` is the reconnect fallback. An `error`
frame carries `{ error, code?, reason? }`: `code` is the provider's own discriminant, `reason`
the provider-neutral one where it applies — `context_exceeded`, `max_turns`, `tool_limit`, or
`timeout` (the same value `read` reports as `turn.errorReason`).

**Errors** are plain refusals, not retryable 503s: a malformed `personaId` or an over-long
prompt is answered before the pool is touched. `at-capacity` means the app's own `max` is
spent; `no-slot` means `MAX_AGENTS` is.

### Windows — `yaar://windows/{windowId}`

The canonical way agents address windows. The monitor is injected automatically from the agent's context. A window is the **running** instance; `yaar://apps/{appId}` is the installed app it came from.

| URI | Description |
|-----|-------------|
| `yaar://windows/` | Window collection (list, create) |
| `yaar://windows/{windowId}` | Window (describe, read, list, update, subscribe, message, delete) |
| `yaar://windows/{windowId}/state/{key}` | One state key of an app window (describe, read) |
| `yaar://windows/{windowId}/state/__{content,screenshot,console}` | The **window's own** state keys — see below (describe, read) |
| `yaar://windows/{windowId}/commands/{key}` | One command of an app window (describe, invoke) |
| `yaar://windows/{windowId}/history` | The window's own log — every `app_command` sent to it, and the replays/restores the server did (describe, list, read, invoke `restore`) |
| `yaar://windows/{windowId}/history/{seq}` | One history entry with its full params (read) |

| Verb | URI | Effect |
|------|-----|--------|
| `describe` | `yaar://windows/{windowId}` | This instance's manual — the live manifest when the iframe has registered (`source: 'live'`), the app's on-disk `protocol.json` when it has not (`source: 'manifest'`). A non-app window answers with the action set filtered to its renderer instead. Either way, `builtinState` carries the window's own keys |
| `read` | `yaar://windows/{windowId}` | Metadata (including `z` and `focused` — see below) + `__content`; on an iframe window, metadata + `__screenshot` instead, with `contentOmitted` naming where the content went |
| `list` | `yaar://windows/{windowId}` | *That window's* built-in keys, then the app's state keys and commands, as sub-path resource links. **The index**: a command's `description` is its rendered signature plus the *first sentence* of its documentation, so the list is enough to call from without being the whole manual — for a 52-command app it is ~10 KB rather than 80. `describe` on the row's own URI has the full text |
| `read` | `yaar://windows/{windowId}/state/{key}` | One state value — the same executor as `app_query` |
| `read` | `yaar://windows/{windowId}/state/{key}/{seg}/…` | One part of a state value. The app is asked for `{key}`; the server walks each segment as an object key or the `id` of an array element (`state/scene/nodes/{nodeId}/geometry`); a position is `__idx/{n}` (`nodes/__idx/0`), so a numeric id stays reachable. A miss names what that level has. `pattern`/`lines` filter the selected part (`packages/server/src/lib/state-path.ts`) |
| `read` + `pattern` | `yaar://windows/{windowId}/state/{key}[/…]` | On an object or array value, and without `lines`, a path search: one `path: value` line per leaf, tested against the pattern, each path appendable to the read URI (ids for elements with a unique one, `__idx/{n}` otherwise). `context: N` shows N sibling values on each side under the same parent, containers summarized as `{keys}`/`[n]`. A text value keeps the numbered line grep |
| `invoke` | `yaar://windows/{windowId}/commands/{key}` | Run one command; the payload **is** its params. An **array** payload runs it once per element, in order (see [Batching](#batching)) |
| `list` / `read` | `yaar://windows/{windowId}/history` | What has been done to the window, oldest first: each `app_command` (command, params preview, sender, `ok`/`error`) and each `replayed` / `restored` event. `list` gives one link per entry; `read` the entries as JSON; `read …/history/{seq}` one entry with full params. Holds what *agents* sent — state the user produced inside the window was never a command and is not here |
| `invoke` | `yaar://windows/{windowId}/history` | `{ action: 'restore', upTo: <seq> }` — forget every entry after `upTo` (0 = all) and remount; the kept commands are replayed on re-registration, so the window comes back as it stood at that seq. Commands the app declares `replay: 'never'` stay in the log but are not re-sent, and the response says how many. Refused on a window locked by another agent, like `reload` |
| `describe` | `yaar://windows/{windowId}/{state,commands}/{key}` | That key's doc — the app's computed `describe()` if it defines one, otherwise the manifest's static `description`. A command also carries `signature`, a rendered `invoke` example, and its `schema` |

**`invoke` actions on `yaar://windows/{windowId}`** (the `action` payload field; `create` runs only on the bare `yaar://windows/` collection):

| Action | Params | Effect |
|--------|--------|--------|
| `create` | `title, renderer, content, x?, y?, width?, height?, minimized?, jsonfile?` | Create a window (`yaar://windows/` only) |
| `update` | `operation` (`append`\|`prepend`\|`replace`\|`insertAt`\|`clear`, required), `content?`, `position?` | Change a window's content |
| `close` | — | Close the window |
| `reload` | — | Re-mount the content; the window, its app agent and its subscriptions survive, the iframe's in-memory state does not |
| `lock` / `unlock` | — | Claim or release the window's edit lock for the calling agent |
| `move` | `x, y` (numbers, required) | Reposition the window |
| `resize` | `width, height` (positive numbers, required) | Resize the window |
| `app_query` | `stateKey?` (default `"manifest"`) | Read one state key — equivalent to `read('.../state/{key}')` |
| `app_command` | `command, params?, timeoutMs?` | Run one app command (default wait 30s, max 180s) |
| `app_eval` | `expression, timeoutMs?` | Evaluate a JS expression in the iframe, JSON-serialized result capped at 16KB (default wait 5s, max 180s). Devtools preview windows only |
| `message` | `message, hook?, fresh?` | Send a message to the window's app agent; `hook: "response"` notifies on reply, `fresh` answers on a brand-new agent |
| `subscribe` | `events?` (any of `content, interaction, close, lock, unlock, move, resize, title`; default `content, interaction, close`), `debounceMs?` (default 500, clamped 100–5000) | Subscribe to window change events → `{ subscriptionId }` |
| `unsubscribe` | `subscriptionId` | Cancel a `subscribe` subscription |
| `app_subscribe` | `channels?` (default `["*"]`), `mode?` (`wake`\|`buffer`, default `wake`), `debounceMs?` (default 500, clamped 100–5000) | Subscribe to an app's declared `app.emit()` channels → `{ subscriptionId }` |
| `app_unsubscribe` | `subscriptionId` | Cancel an `app_subscribe` subscription |

> **Two protocol sources exist**, and `describe` says which it read: `protocol.json` on disk and
> the iframe's own registration diverge after a deploy without a reload.

> **`invoke` on a command sub-path takes no `action`** — the URI names the command, so the payload
> is its params. An `action` or nested `params` is refused. `timeoutMs` is the one reserved key.
> The `{ action: 'app_query' | 'app_command' }` spellings on the bare window URI reach the same
> executor.

> `list('yaar://windows/{windowId}')` returns *that window's* keys; `list('yaar://windows')` returns
> every window on the monitor.

> **`list('yaar://windows')` answers in stacking order, bottom first** — the last link is the window
> on top. Each line carries `z:{n}` (rank among *this monitor's* windows, `0` at the bottom; a panel
> says `fixed`, since panels do not stack) and `focused` on the one the desktop has focused. The
> server mirrors the desktop's z-order from the actions and interactions it already sees — see
> [OS Actions Reference → Stacking order](./os_actions_reference.md#stacking-order).

**Three state keys belong to the window, not to the app inside it:**

| Key | Answers | Available on |
|-----|---------|--------------|
| `__content` | the window registry — no capture, no round trip to the app | every window |
| `__screenshot` | a `window.capture` round trip to the frontend | iframe windows |
| `__console` | the injected app-protocol script's capture buffer | iframe windows |

- A window with no protocol lists what it has: `list('yaar://windows/{markdownWindow}')` returns
  `state/__content`, with a note saying there is no app.
- A bare `read` of an iframe window is `__content` + `__screenshot`. The screenshot wins (an app
  window's raw content is a compiled HTML blob), so `content` is replaced by `contentOmitted`,
  which names the URI holding it.

The `__` prefix is reserved: an app declaring a state key by one of these names is shadowed, not
merged. `invoke(..., { action: 'app_query', stateKey: '__content' })` reaches the same answer as
reading the sub-path.

`buildWindowResourceUri` / `parseWindowResourceUri`
(`packages/server/src/lib/yaar-uri-server.ts`) mint and read these URIs, and
`enrichManifestWithUris` stamps one onto every state and command entry of every live manifest —
so an agent reading the manifest is handed URIs it can call directly.

> `yaar://monitors/{monitorId}` survives only as an internal `ContextSource` tag
> (`agents/context.ts`) for tagging message history — it is **not** an addressable resource URI.
> Monitors are addressed as `yaar://session/monitors/{monitorId}`.

### Config — `yaar://config/...`

| URI | Description |
|-----|-------------|
| `yaar://config/settings` | User settings |
| `yaar://config/hooks` | Event hooks |
| `yaar://config/hooks/{id}` | Specific hook entry |
| `yaar://config/shortcuts` | Keyboard shortcuts |
| `yaar://config/shortcuts/{id}` | Specific shortcut |
| `yaar://config/mounts` | Host directory mounts |
| `yaar://config/app/{appId}` | App credentials/config |
| `yaar://config/domains` | HTTP domain allowlist |
| `yaar://config/mcp` | MCP server configuration (`mcp-servers.json`). `read` lists all `{ servers }`; `invoke { name, config }` adds or updates one |
| `yaar://config/mcp/{name}` | One MCP server config entry. `read` for its config; `delete` to remove it |

### Session — `yaar://session/...`

Session-scoped resources. The whole namespace is **session-principal**, `yaar://session/agents`
and `yaar://session/agents/*` included: a caller gets in iff its role is `session` **or** it is a
bundled `kind: "system"` app presenting an iframe token (enforced centrally in
`ResourceRegistry.execute()`, the gate both doors end at, and derived from the prefix at
registration, so no handler under it can opt out or forget). Monitor and app agents get a 403 — an
app/window agent hands work back to its monitor through its own `relay` tool, not through
`yaar://session/agents/monitor`.

| URI | Description |
|-----|-------------|
| `yaar://session` | Current session info (platform, uptime, stats) |
| `yaar://session/agents` | All active agents. `list` returns two views of the same roster: `agents` (flat) and `tree` (nested by ownership — session → monitor → app → sub-agent). A `tree` node with `id: null` is an owner slot nobody occupies, e.g. an app whose sub-agents exist but whose own agent was never needed. See [The Agent Tree](../architecture/monitor_and_windows_guide.md#the-four-laws) |
| `yaar://session/agents/{agentId}` | Agent by instance ID — read for info; invoke with `{ action: 'interrupt' }` (any agent) or `{ action: 'relay', message }` (only on `.../monitor` — hands a message from an app/window agent back to its monitor agent); delete disposes the session agent (`id === 'session'`) or an app agent (by instanceId or appId) |
| `yaar://session/agents/session` | The session agent itself (invoke with `audit` / `coordinate` / `query`) |
| `yaar://session/monitors/{monitorId}` | Monitor status and control (see below) |
| `yaar://session/browser` | The user's real Chrome — the only CDP door to it (the Real Browser app reaches it through the Bridge extension instead) |
| `yaar://session/context` | Context state |

Past session logs are **not** under `yaar://session/...` — they're the separate top-level
`history` namespace (see [URI Space](#uri-space) above): `list('yaar://history/')` for links,
`read('yaar://history/')` for summaries, and `read('yaar://history/{id}')` /
`read('yaar://history/{id}/transcript')` / `read('yaar://history/{id}/messages')` for detail.
Handler: `packages/server/src/handlers/history.ts`.

**Monitor control** (`yaar://session/monitors/{id}`):

| Verb | Effect |
|------|--------|
| `read` | Monitor detail: agent status (busy/idle), suspended state, queue depth, windows |
| `invoke { action: "suspend" }` | Pause the monitor's queue — agent stays alive, tasks enqueue but don't process |
| `invoke { action: "resume" }` | Unpause and drain pending tasks |
| `invoke { action: "interrupt" }` | Interrupt the monitor's current task |
| `delete` | Dispose the monitor agent and clear its queue |

**Session agent actions** (`yaar://session/agents/session`):

| Action | Payload | Effect |
|--------|---------|--------|
| `audit` | — | Reviews all monitors, reports anomalies |
| `coordinate` | `{ plan: "..." }` | Orchestrates cross-monitor work |
| `query` | `{ question: "..." }` | Answers questions about session state |

### User — `yaar://user/...`

Callable by every agent tier:

| URI | Description |
|-----|-------------|
| `yaar://user/notifications` | Show notification (invoke with `{ id, title, body }`) |
| `yaar://user/notifications/{id}` | Dismiss notification (delete) |
| `yaar://user/prompts` | User prompts (invoke with `{ action: 'ask' \| 'request', ... }`) |
| `yaar://user/clipboard` | The system clipboard: `read` for what is on it, `invoke` with `{ action: 'write', text }` or `{ action: 'save', path }` |

#### The clipboard is the browser's

YAAR has no clipboard of its own. `read('yaar://user/clipboard')` emits a `user.clipboard.read`
action, the desktop answers with a `CLIPBOARD_RESPONSE` frame, and the turn is parked in between
(registered in `ANSWER_EVENT_TYPES`, `packages/shared/src/events/routing.ts`). Consequences:

- **A refusal is the browser's.** Reads are gated by the browser's clipboard permission; the answer
  distinguishes `denied` from `not-focused` (browsers refuse a read to an unfocused tab).
- **Under `REMOTE=1` it is the *viewing* device's clipboard**, not the server host's.
- **No desktop attached, no clipboard.** A read outside a live session fails immediately.

#### Ceilings, and the door past them

A `read` is sized for a conversation, and says so whenever it trims (constants:
`packages/server/src/features/user/clipboard.ts`):

| | `read` | `invoke { action: 'save' }` |
|---|---|---|
| Text | first 20,000 characters, with the true length reported | untruncated, to the file |
| Image | downscaled to 1600px on its longest edge, ≤4 MB | full resolution, ≤32 MB |
| Returns | the content | a `yaar://storage/...` URI |

Truncation happens **in the desktop**, before the data crosses the socket. `save` writes the whole
thing to storage and hands back the URI. An image wins over text when the clipboard holds both.

#### Credentials are taken out first

Clipboard **text** is scanned before it is handed over, and every match is replaced with a
`[redacted: aws-access-key-id #1]` placeholder naming what was there (the read still succeeds; a
read that removed something says so). Detector: `packages/server/src/features/user/secret-scan.ts`.

- **Vendor-prefixed credentials only** — `ghp_`, `sk-ant-`, `AKIA`, `AIza`, `xoxb-`, PEM
  private-key blocks, JWTs, a password in a connection URL. Unlabeled high-entropy strings pass.
- **Images are not scanned.**
- **`save` is scanned too, and writes the redacted text.**

`YAAR_CLIPBOARD_SECRETS=0` turns the scan off ([server_env.md](./server_env.md)).

### System — `yaar://system/...`

The running installation itself, rather than anything inside a session. Not session-principal —
an app that declares the permission can call it (the Configurations app does — this is what its
**Updates** tab renders), and so can every agent tier — with one exception: acting on a single
sandbox browser session (`yaar://system/browsers/{id}`) is session-principal, so one app cannot
end another window's session because it was granted the prefix.

| URI | Verb | Description |
|-----|------|-------------|
| `yaar://system` | `list` | Enumerate system resources |
| `yaar://system/update` | `read` | Running version, build shape, last check result, live install progress. **Never touches the network** — safe to poll |
| `yaar://system/update` | `invoke` `{ action: 'check', force? }` | Ask GitHub for the latest release. Cached 5 minutes; `force` bypasses the cache |
| `yaar://system/update` | `invoke` `{ action: 'install' }` | Download the latest release, verify it against the release's `SHA256SUMS`, and swap it in. Returns once the work has *started* — poll `read` for the outcome |
| `yaar://system/browsers` | `list`, `read` | Sandbox browser sessions (the server-side Chrome only, never the user's): id, page, `state` (`live` / `suspended` / `crashed`), whether it is watched, idle time. `list` adds `chromeRunning`, `maxSessions`, `liveSessions` |
| `yaar://system/browsers/{id}` | `read` | One session. **Session-principal** |
| `yaar://system/browsers/{id}` | `invoke` `{ action: 'revive' }` | Put a socket back behind a suspended id — the page is re-navigated and the persisted profile still holds its cookies. **Session-principal** |
| `yaar://system/browsers/{id}` | `delete` | Kill the session, closing the window showing it. **Session-principal** |

`install` refuses synchronously (rather than failing later in the progress state) when there is
nothing to install, when GitHub was unreachable, or when this build cannot install updates at all
— only the standalone executable can replace itself, so a source checkout is told to use
`git pull` and a platform with no published binary is told to build from source. A checksum
mismatch, or a release with no `SHA256SUMS`, is a hard failure: nothing unverified is installed.
Installing never restarts YAAR; the user does that.

**Source:** `packages/server/src/features/update/`, `packages/server/src/handlers/system.ts`. How browser sessions work: [Browser Automation](../architecture/browser_automation.md)

---

## Verb Layer

Five verbs. The URI identifies the resource; the verb determines the operation.

**`describe` is the manual, `read` is the current value, `list` is what's addressable.**

| Verb | Semantics | Returns |
|------|-----------|---------|
| `describe` | The manual — what this resource *is* and what may be done with it | `{ uri, description, verbs, invokeSchema? }`, or a handler's own richer shape |
| `read` | The current value — what the resource holds right now | Resource-specific data |
| `list` | What is addressable under the URI | MCP `resource_link` content blocks, one per child (`{ uri, name, description?, mimeType?, kind?, version? }`) — not a JSON object with an `items` key |
| `invoke` | Mutate, create, or trigger — the universal write/action verb | Resource-specific result |
| `delete` | Remove a resource | `{ deleted: true }` |

The three are not interchangeable: `describe('yaar://apps/notes')` is Notes' protocol and SKILL.md, `read('yaar://apps/notes')` is what version is installed and what it was granted.

**Describing a URI that names nothing is an error, not a plausible success**, so a `describe` that answers is proof the resource exists. The auto-generated form describes the URI *pattern*, which is an honest answer only when the URI names something — hence the `exists` hook below.

`invoke` covers both data mutation (idempotent merges like config updates) and side-effecting actions (browser navigate, agent interrupt). The URI identifies *what* is being acted on; the payload's `action` field (when needed) specifies *how*.

### Examples

```
read('yaar://config/settings')                          -> { theme: 'dark', ... }
invoke('yaar://config/settings', { theme: 'light' })    -> merge into settings
delete('yaar://config/app/github')                      -> remove app config

read('yaar://windows/win-1')                            -> window state
invoke('yaar://windows/', { action: 'create', title: 'Notes', renderer: 'markdown', content: '# Hello' })
invoke('yaar://windows/', { action: 'create', title: 'Plan', renderer: 'markdown', content: 'yaar://storage/plan.md' })
invoke('yaar://windows/win-1', { action: 'update', operation: 'append', content: '...' })
invoke('yaar://windows/win-1', { action: 'subscribe', events: ['content', 'interaction'] })  -> { subscriptionId }
invoke('yaar://windows/win-1', { action: 'unsubscribe', subscriptionId: 'wsub-...' })
delete('yaar://windows/win-1')                          -> close window

list('yaar://session/agents')                  -> active agents
invoke('yaar://session/agents/agent-1', { action: 'interrupt' })
invoke('yaar://session/agents/monitor', { action: 'relay', message: '...' })  -> app/window agent hands a message back to its monitor agent
delete('yaar://session/agents/session')        -> dispose the session agent
delete('yaar://session/agents/notes')          -> dispose the "notes" app's agent

invoke('yaar://user/notifications', { id: 'n1', title: '...', body: '...' })
delete('yaar://user/notifications/n1')         -> dismiss notification
invoke('yaar://user/prompts', { action: 'ask', title: '...', message: '...', options: [...] })

read('yaar://session/monitors/0')              -> monitor status
read('yaar://session')                         -> session info

describe('yaar://config/settings')             -> { verbs: ['describe', 'read', 'invoke'], invokeSchema: { ... } }
```

For the text renderers — `markdown`, `html`, `text` — a `content` that is *exactly* a
`yaar://storage/{path}` URI is read and its text becomes the window's content, mirroring the
URI `iframe` already accepts. Two things follow: it is a **snapshot** taken at the moment of the
call, so a later write to the file does not reach an open window (reissue the create, or
`update` it); and it is refused, rather than silently rendered as a literal string, when the
file is missing, is not text, is over 512 KB, or when the caller is an app — an app reads its
own files and passes the text. A URI embedded in a longer string is ordinary content and stays
literal.

HTTP requests also flow through the verb layer: `invoke('yaar://http', { url, ... })`, with domain allowlisting at `invoke('yaar://config/domains', { domain })`. `delete('yaar://http')` clears the caller's stored cookie jar (use on app logout).

The response shape depends on who asked. An **app iframe** gets `{ ok, status, headers, body, bodyEncoding: 'base64' }`, which `yaarFetch` turns back into a `Response`. An **agent** gets text on `body`; an image (identified from its bytes) comes back as an image block, and any other binary body is omitted with `bodyOmitted`, `bodyBytes`, and a hint. Session and monitor agents retrieve binary with `saveTo` (a path relative to `yaar://storage/`) and get `{ saved: { uri, bytes } }`; it streams to disk, bounded by `YAAR_MAX_DOWNLOAD_MB` (512MB) rather than the 10 MB inline cap, and a failed transfer leaves nothing at the destination.

### Batching

A call batches on **either axis**, and the two are independent:

```
invoke('yaar://storage/{a.txt,b.txt}', { content: '...' })   -> many URIs, one payload  (parallel)
invoke('yaar://windows/studio-3d/commands/setTransform', [   -> one URI, many payloads (in order)
  { id: 'left-eye',  position: { x: -0.12 } },
  { id: 'right-eye', position: { x:  0.12 } },
])
```

**URI axis** — brace expansion, available on **all five verbs**, not only `invoke`: `describe`, `read`, `list`, `invoke` and `delete` each expand their `uri` the same way, handled once above the registry (`handlers/index.ts`) before dispatch, and every MCP tool description says so. Expanded URIs name distinct resources, so they run concurrently and every result is reported.

**Payload axis** — an array payload to `invoke`, handled in `ResourceRegistry.execute`. Because the elements are edits to *one* resource they run **sequentially**, and the batch **stops at the first failure**, reporting the index that failed and how many were not attempted — resend from that index. Max 100 elements; a longer list is refused, never truncated. Handlers never see the array: each element reaches `handler.invoke` as an ordinary payload, so no resource opts in or can get it wrong. Available to agents (the `invoke` MCP tool) and to apps (`POST /api/verb`, `invoke()` from `@bundled/yaar`) alike.

It is a spelling, not a transaction: N elements are N calls, so an app that records undo steps records N of them. One undo step needs a command that takes a list (`addNodes`) rather than a batched call.

### MCP Surface

One MCP tool per verb, served from the `verbs` namespace:

| Tool Name | Parameters |
|-----------|------------|
| `describe` | `{ uri }` |
| `read` | `{ uri, lines?, pattern?, context?, pdfText?, pdfPages?, rawImage?, gltfNode?, gltfDepth?, gltfKeys?, gltfPose?, gltfAt?, gltfRange?, gltfStep?, gltfEuler?, gltfOmit? }` — `lines` (e.g. `"10-20"`, `"50"`, `"100-"`) and `pattern` (regex, matching lines only) filter text files; `context` sets lines of context around a `pattern` match (default 0); `pdfText` (`boolean \| string`) extracts a PDF's text layer, `pdfPages` (e.g. `"1-3"`) rasterizes a page range to images — omitting both returns PDF metadata only; `rawImage` returns an image's stored bytes instead of the WebP re-encode reads normally apply; a `.glb`/`.gltf` reads as a model summary, which `gltfNode` scopes to a subtree, `gltfDepth` trims, and `gltfKeys` extends with one animation's full keyframes (windowed by `gltfRange`, resampled by `gltfStep`); `gltfPose` plays a clip — with `gltfAt` a world-space snapshot, without it `gltfNode`'s world path; `gltfEuler` shows rotations as degrees, `gltfOmit` drops sections |
| `list` | `{ uri, sort?, order?, range? }` — storage folders only (elsewhere ignored, with a note): `sort` is `name`/`modified`/`size`, `range` pages entries 1-based (`"201-400"`); with no `range` a folder returns its first 200 entries and a note with the total |
| `invoke` | `{ uri, payload? }` — `payload` is an object, or an array of objects (see [Batching](#batching)) |
| `delete` | `{ uri }` |

Active MCP namespaces (`CORE_SERVERS` in `mcp/server.ts`): `system`, `verbs`, `app`, `messaging`, `subagent`.

---

## ResourceRegistry

Central registry in `packages/server/src/handlers/uri-registry.ts`. Maps URI patterns to handler objects.

```typescript
type Verb = 'describe' | 'read' | 'list' | 'invoke' | 'delete';

interface ResourceHandler {
  description: string;           // human-readable, returned by `describe`
  verbs: Verb[];                 // which verbs this handler supports (describe is always auto-generated)
  invokeSchema?: Record<string, unknown>;  // JSON Schema for invoke payload (optional)
  access?: 'session-principal';  // when set, only the session agent or a bundled system app's
                                 // iframe token may call any verb (403 for everyone else);
                                 // implied for every pattern under yaar://session

  exists?(resolved: ResolvedUri): Promise<boolean>;       // consulted before the auto-generated describe
  describe?(resolved: ResolvedUri): Promise<VerbResult>;  // custom describe; overrides auto-generation
  read?(resolved: ResolvedUri, options?: ReadOptions): Promise<VerbResult>;
  list?(resolved: ResolvedUri): Promise<VerbResult>;
  invoke?(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult>;
  delete?(resolved: ResolvedUri): Promise<VerbResult>;
}
```

Patterns use authority + optional path prefix, matched by specificity (exact > prefix > wildcard):

```
'yaar://config/settings'  -> matches exactly
'yaar://config/'          -> matches yaar://config/ and anything under it
'yaar://config/*'         -> wildcard match under yaar://config/
```

**A `/*` wildcard must declare either `exists` or `describe`, and `register()` throws otherwise** — the auto-generated `describe` answers from the *pattern*, identically for a live resource and one that never existed. `exists` returning false makes `describe` answer `No resource at <uri>.`. Exact and prefix patterns are exempt.

`yaar://session/{agents,monitors}/*`, `yaar://config/{mcp,hooks,shortcuts,mounts,app}/*` and `yaar://skills/*` take the hook; `yaar://windows/*`, `yaar://apps/*`, `yaar://storage/*`, `yaar://mcp/*` and `yaar://user/notifications/*` answer for themselves (a notification is an emitted action, not a stored resource, so its `describe` says so).

Each domain registers its handlers during server startup (`handlers/config.ts`, `handlers/window.ts`, etc.). For action-bearing resources (browser, agents), the handler dispatches on `payload.action`:

```typescript
// handlers/agents.ts — registered under yaar://session/agents
registry.register('yaar://session/agents/*', {
  verbs: ['read', 'invoke', 'describe'],
  description: 'Agent instance. Read for info, invoke to interrupt.',
  invokeSchema: {
    type: 'object',
    required: ['action'],
    properties: { action: { type: 'string', enum: ['interrupt'] } },
  },
  async read(resolved) { /* ... */ },
  async invoke(resolved, payload) { /* ... */ },
});
```

`ResourceRegistry.execute(verb, uri, payload)` is also the **access-control chokepoint**: it resolves the calling agent's principal role (`session` / `monitor` / `app`) and rejects out-of-tier access before the handler runs.

---

## Where URIs Are Used

**Window content** — `content` fields use `yaar://` URIs; the server resolves them to API paths before sending to the frontend:

```
invoke('yaar://windows/', { action: "create", title: "Slides Lite", renderer: "iframe", content: "yaar://apps/slides-lite" })
invoke('yaar://windows/', { action: "create", title: "Q4 Report", renderer: "iframe", content: "yaar://storage/reports/q4.pdf" })
```

(There is no `uri` field in the create payload — `handleCreate` derives the window id from
`appId`/`name`/`title` via `deriveWindowId`, and the `content` field carries the `yaar://` URI.)

**Desktop shortcuts** — shortcuts use `yaar://` URIs as their `target`; `extractAppId()` parses app identity from it.

**App discovery API** — `GET /api/apps` returns `run` fields as `yaar://` URIs (custom `run` paths in `app.json` become `yaar://apps/{appId}/{path}`).

## Resolution Helpers

All exported from `@yaar/shared`:

```typescript
resolveContentUri('yaar://apps/slides-lite')      // -> '/api/apps/slides-lite/dist/index.html'
resolveContentUri('yaar://storage/docs/file.txt') // -> '/api/storage/docs/file.txt'

parseFileUri('yaar://storage/docs/file.txt')      // -> { authority: 'storage', path: 'docs/file.txt' }

parseYaarUri('yaar://apps/storage')               // -> { authority: 'apps', path: 'storage' }
buildYaarUri('apps', 'slides-lite')               // -> 'yaar://apps/slides-lite'
buildYaarUri('storage', 'docs/file.txt')          // -> 'yaar://storage/docs/file.txt'
extractAppId('yaar://apps/slides-lite')           // -> 'slides-lite'
```

Resolution points: the server resolves iframe content URIs in `features/window/create.ts`; the frontend resolves asset URLs (plus remote-mode auth) in `lib/api.ts`.

## Key Files

| File | Role |
|------|------|
| `packages/shared/src/yaar-uri.ts` | URI parser, builder, resolver for all namespaces |
| `packages/server/src/handlers/uri-registry.ts` | `ResourceRegistry` — central handler registry + principal enforcement |
| `packages/server/src/handlers/uri-resolve.ts` | Server-side typed resolution for all URI namespaces |
| `packages/server/src/lib/verb-result.ts` | `VerbResult` + the pure result builders (`ok`, `okJson`, `error`, `okLinks`, …) |
| `packages/server/src/lib/read-options.ts` | `ReadOptions` and the read filters (`lines`/`pattern`/`chars`), `applyEdit` |
| `packages/server/src/handlers/index.ts` | The 5 verb MCP tool definitions |
| `packages/server/src/handlers/{config,window,agents,...}.ts` | Per-namespace handler registration |
| `packages/server/src/http/routes/verb.ts` | `POST /api/verb` — iframe verb access with token + permission checks |
| `packages/frontend/src/lib/api.ts` | Frontend URI resolution + remote auth |

---

## Iframe Verb Access & Token Validation

Iframe apps call verbs via HTTP (`POST /api/verb`), gated by a per-window token and the permission list declared in `app.json`.

### Token Lifecycle

```
Window created (server)
  → generateIframeToken(windowId, sessionId, appId, permissions)
  → Token included in window.create OS action payload
  → Frontend hands the token to the iframe:
     1. URL query param: ?__yaar_token=<token>   (same-origin frames and origin-isolated apps)
     2. Script injection: window.__YAAR_TOKEN__ = '<token>'   (same-origin frames only)
  → Any other cross-origin iframe receives no token (no verb access)
  → Iframe SDK reads token from either source
  → All /api/verb requests include X-Iframe-Token header
  → Token expires after 24 hours (auto-cleaned)
  → Token revoked when window closes
```

**Source:** `packages/server/src/http/iframe-tokens.ts`

### Permission Enforcement

Apps declare which URIs they can access in `app.json`:

```json
{
  "permissions": ["yaar://storage/"]
}
```

The verb route (`POST /api/verb`) enforces this:

1. Extract `X-Iframe-Token` header
2. Validate token → get `TokenEntry` (windowId, sessionId, appId, permissions)
3. Check URI against permissions: exact match or prefix match (entries ending in `/`)
4. No match → 403

Apps with no `permissions` field still get the auto-granted `yaar://apps/self/{storage,db,agents}/`
subtrees (`SELF_GRANTS`), and `describe` is always allowed on any URI regardless of permissions
(metadata-only). Everything else — `read`/`list`/`invoke`/`delete` on any other resource — needs
an explicit `permissions` entry.

### `yaar://apps/self/` Resolution

`self` is a shorthand for the app's own appId, resolved server-side from the token entry (403 if the token has no appId):

```
yaar://apps/self/storage/data.json  →  yaar://apps/{actual-appId}/storage/data.json
```

### Iframe SDK

Apps should use `@bundled/yaar` imports (the underlying globals are injected by `IFRAME_VERB_SDK_SCRIPT` from `packages/shared/src/iframe-scripts/verb-sdk.ts`, re-exported via `packages/shared/src/iframe-scripts/index.ts` and `packages/shared/src/index.ts`):

| `@bundled/yaar` import | Endpoint |
|-------------------------|----------|
| `invoke(uri, payload?)` | `POST /api/verb` |
| `read(uri)` | `POST /api/verb` |
| `list(uri)` | `POST /api/verb` |
| `describe(uri)` | `POST /api/verb` |
| `del(uri)` | `POST /api/verb` |
| `subscribe(uri, cb)` | `POST /api/verb/subscribe` (`mode: 'change'`) |
| `stream(uri, onFrame, opts?)` | `POST /api/verb/subscribe` (`mode: 'stream'`) — like `subscribe`, but the server pushes typed `{ uri, seq, kind, data, ts }` frames instead of bare change pings; `opts.kinds` narrows delivery to listed frame kinds. Returns an unsubscribe thunk |
| `httpFetch(input, init?)` | Cross-origin: `POST /api/fetch` (domain-allowlisted, real `Response` returned); same-origin/relative: passthrough `window.fetch` with the `X-Iframe-Token` header attached |

All requests automatically include the `X-Iframe-Token` header. Subscription updates arrive via `postMessage` with type `yaar:subscription-update`, carrying the URI that changed — apps call `read` to fetch the new value.
