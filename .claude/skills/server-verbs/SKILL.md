---
name: server-verbs
description: The YAAR server's MCP tool and verb layer - URI verbs, protocol eras, access tiers, app protocol, sub-agents. Use when editing handlers/, mcp/, or features/ in packages/server.
paths:
  - "packages/server/src/handlers/**"
  - "packages/server/src/mcp/**"
  - "packages/server/src/features/**"
---

This skill covers the YAAR server's MCP tool and URI verb layer: the 5 generic verbs, the two
protocol eras sharing one endpoint, verb semantics, batching, access tiers, the App Protocol,
app-agent storage declarations, monitor/app-agent communication, sub-agents, and the self-update
feature. The content below is carried over verbatim from `packages/server/CLAUDE.md`.

## Tools (MCP)

The active MCP namespaces (`CORE_SERVERS` in `mcp/server.ts`) are `system`, `verbs`, `app`,
`messaging`, and `subagent`. The `verbs` server exposes 5 generic tools (`describe`, `read`,
`list`, `invoke`, `delete`) that dispatch to thin handler files in `handlers/` (which import
domain logic from `features/`) via `yaar://` URIs.

| Domain | Namespace | Summary |
|--------|-----------|---------|
| `handlers/` | verbs | describe, read, list, invoke, delete — 5 generic URI verbs dispatching via `yaar://` URIs |
| `mcp/system/` | system | reload_cached, list_reload_options |
| `mcp/app-agent/` | app | describe, query, command, relay (+ direct_message when granted). The `storage:*` built-ins are **declared, not automatic** — see below |
| `mcp/messaging/` | messaging | Cross-agent direct messaging |
| `mcp/sub-agent/` | subagent | app-defined tools of the *calling* sub-agent — the only namespace whose tool list depends on who connects; empty for everyone else |

Tools use `actionEmitter.emitAction()` to broadcast actions to frontend and optionally wait for
rendering feedback. Window tools support lock protection — only the locking agent can modify a
locked window.

### Two protocol eras, one endpoint

`handleMcpRequest` forks per request: 2025-era traffic keeps the **stateful** path (`initialize`
mints an `mcp-session-id`), a **2026-07-28** client is stateless and routed to `createMcpHandler`.
YAAR asks **both** providers to negotiate up — Codex via `features.mcp_2026_07_28=true`, Claude via
`MCP_SDK_GENERATION=v2` + `MCP_PROTOCOL_NEGOTIATION=auto` (both vars required; either alone is a
no-op).

**Two traps that will cost you a day each are documented at `getModernHandler` in
`mcp/server.ts` — read it before touching this fork.** Both rows are pinned by
`tests/mcp-protocol-eras.test.ts`.

**The legacy leg is deprecated and instrumented.** Its machinery is fenced between
`BEGIN/END deprecated: 2025-era stateful leg` banners in `mcp/server.ts` and every declaration
inside carries `@deprecated` — the fence is where the eventual cut goes, so **don't add to it or
reach into it from the modern path**. `getMcpEraStats()` reports the counters that gate the
deletion; criteria in `docs/proposals/mcp_modern_only_proposal.md`.

### Verb semantics

**`describe` is the manual, `read` is the current value, `list` is what's addressable.** A handler
that blurs the three makes a prompt offer rather than instruct.

| | `yaar://apps/{id}` — the *installed* app | `yaar://windows/{id}` — the *running* instance |
|---|---|---|
| `describe` | identity + `agent/SKILL.md` + permissions + the **names** of its state keys and commands + this door's `verbs`/`invokeActions`/`subPaths` | this instance's manual, tagged `source: 'live'` (the iframe's registration) or `'manifest'` (disk), plus `builtinState` |
| `read` | the effective, **post-grant** manifest from `getAppMeta` | metadata + `__content`, or metadata + `__screenshot` for an iframe |
| `list` | ✗ not a collection | this window's built-in keys, then the app's state keys and commands, as an **index** (signature + first sentence) |
| sub-paths | `protocol`, `storage/`, `db/`, `agents/` | `state/{key}`, `commands/{key}` |

Six rules hold this together, each closing a false success. **Each is documented in full at the
named site**:

- **`exists?(resolved)` on `ResourceHandler`** is consulted before the auto-generated `describe`; a `/*` wildcard that declares neither `exists` nor `describe` makes `register()` **throw**. (`handlers/uri-registry.ts`)
- **The same action list is declared once** — `defineActions` derives the schema `enum`, `describe`'s `invokeActions`, and the dispatch from one table. (`handlers/define-actions.ts`)
- **`yaar://apps/{id}/state/…` and `/commands/…` are refused on every verb** — protocol state belongs to a running window, and the same app on two monitors is two states. (`handlers/apps/register.ts`)
- **Every other unclaimed sub-path is refused too** — a false success is worse than a 404. (`rejectUnhandledSubPath`, same file)
- **A missing directory is an error, not an empty list** (`storageList` sets `notFound`); namespace roots opt back in explicitly.
- **A resource that exists and holds nothing answers, it does not complain** — every window has the three built-in state keys (`BUILTIN_STATE`: `__content`, `__screenshot`, `__console`; `__` is reserved). (`handlers/window.ts`)

### Batching

**A call batches on two axes, and neither is a handler's business.** Brace expansion
(`handlers/index.ts`) batches *URIs* against one payload, concurrently. An **array payload** to
`invoke` batches *payloads* against one URI, run **sequentially** by `ResourceRegistry.execute`,
stopping at the first failure and naming the index to resend from. Each element is resolved,
access-checked and verb-checked exactly as a lone invoke would be — **a batch is a spelling, never
a bypass.** `handler.invoke` never sees the array (`MAX_BATCH_PAYLOADS = 100`, refused rather than
truncated; rationale at that declaration in `uri-registry.ts`).

Only one of the two axes exists at each door: brace expansion is the MCP `exec` wrapper's, so
`POST /api/verb` refuses a brace URI by name. The array-payload axis works at both.

### Access tiers

Every agent carries a principal `role` (`session` / `monitor` / `app`) on its `AgentContext`. A
handler may declare `access: 'session-principal'`, and `ResourceRegistry.execute()` then applies
**one** definition:

> A caller satisfies `access: 'session-principal'` iff its role is `session` **or** it is a
> token-backed bundled system app (`AgentContext.systemApp`).

Everything else is refused — default-deny, so `undefined` is neither. **That gate is the
authority**: both doors into the verb layer end there (MCP tools and `POST /api/verb`), which is
why it, not `http/access.ts`, defines the tier. `access.ts`'s `isSessionUri` refusal stays as the
cheap early 403 and applies the same widening — the two used to answer in different currencies,
so a bundled system app was admitted by one door and 403'd by the other.

`agents/roles.ts` owns both the prefixes a role is minted with and the parse that maps one onto a
tier, so the string and the gate that reads it cannot drift. `systemApp` is set by
`routes/verb.ts` from the **validated iframe token**, never from the request body. The gate's
principal resolver is injected via `setAccessPrincipalResolver()` (wired in `lifecycle.ts`) to
avoid a runtime import cycle.

### App Protocol

Bidirectional agent-iframe communication via `query`/`command` tools (in the `app` MCP server).
Flow: Agent → ActionEmitter → WebSocket → Iframe → response back. Event schemas are in
[`docs/reference/app_protocol_reference.md`](../../../docs/reference/app_protocol_reference.md).

A fourth request kind, `describe`, documents **one** state key or command on demand
(`handleAppDescribe` in `features/window/app-protocol.ts`) — never folded into the manifest, or
every manifest read would pay for every key.

**A protocol has two honest sizes, and they get two doors.** `describe('yaar://apps/{id}')` answers
"what is this app"; the protocol is its own resource (`handlers/apps/protocol-resource.ts`) where
`describe` is counts and doors, `list` is the index, `read` is the manifest, and
`read('…/protocol/commands/{name}')` is one command self-contained and brace-batchable. So the
index is *what `list` means*, not a degradation a byte budget switches on, and nothing is truncated
behind a caller's back. The incident that forced the split is recorded in
`handlers/apps/protocol-resource.ts`'s header; the CLI result-size cliff behind it is named and
moved in `mcp/result-size.ts`.

**A schema may point at the manifest, so every reader has to follow the pointer.** The compiler
hoists a repeated shape into `manifest.$defs` and leaves `{"$ref": "#/$defs/x"}` at each use.
`lib/schema-refs.ts` is the one resolver: `resolveRef` for the renderers (a ref rendered without
the table is `any`) and `selfContained` for any door that hands one descriptor's schema on
**alone**. The three seams that pass `$defs`: `list` on a window (`handlers/window.ts`), the
per-command `describe` (`features/window/app-protocol.ts`), and the app agent's prompt
(`agents/profiles/app-agent.ts`). A descriptor's *top-level* schema is never hoisted, so
`params.properties`/`required` are always readable without a hop.

**A reserved payload key (`action`/`params`/`timeoutMs`) is checked against the command's schema,
not against its name.** Full story at `invokeSubResource` in `handlers/window.ts`.

### App agent storage is declared, not automatic

`query`/`command` intercept storage paths before the app protocol — `storage:write`,
`storage:delete`, `storage:list`, and the relative `storage/{path}` spelling on `query`. An app
agent holds them **iff** its `app.json` declares at least one entry under `yaar://storage/`
(`yaar://storage/apps/` excluded). Four bundled apps do; the rest are refused by name, **including
against their own tree** — a capability the author never declared is not one the agent should hold.

Two layers, one predicate (`declaresSharedStorage`, `mcp/app-agent/shared-storage.ts`):

- **The prompt** — both storage sections are rendered only for a declaring app, at the single site
  in `agents/profiles/app-agent.ts` that assembles them into *either* prompt branch (a `prompt.md`
  app issues the same payloads, and the two sections drifted apart once already).
- **The handler** — refused at call time, with `storageNotDeclared` naming the app's own protocol
  commands as the way forward. An app agent cannot edit its own manifest, so the app.json line is
  an author-facing note, not an instruction (this is the one difference from `direct_message`'s
  refusal, whose reader is a monitor agent).

There is deliberately **no third copy in the tool descriptions**: a description is written once for
every caller, so making it honest per app would mean an appId resolution and an uncached
`getAppMeta` read on every `app`-namespace MCP request — the modern era builds a server per
request. `query`/`command` mention storage nowhere.

**Exposure is not authorization.** A declaration opens the door; `permissionsAllow` still decides
each call, so `{ uri: "yaar://storage/reports/", verbs: ["read","list"] }` exposes the built-ins
and still refuses `storage:write`. The **iframe** side is untouched — `SELF_GRANTS`, the commons in
`permissionsAllow`, and every `POST /api/verb` path. An undeclared app persists through a command
its own `protocol.json` declares (`apps/session-logs`'s `saveReport` is the worked example).

### Monitor ↔ App Agent communication

- **Monitor → App**: `invoke('yaar://windows/{id}', { action: 'message', message: '...' })` — wraps message in `<monitor:{monitorId}>` tags and routes as an app task via `AppTaskProcessor`. Fire-and-forget; use `hook: 'response'` to get the app agent's reply back.
- **Monitor → App, starting over**: the same call with `fresh: true` retires the app agent first (its memory lives in its provider session, which `disposeAppAgent` ends). A `fresh` task never steers, releases inside the processing lock, and drops handoff fingerprints; sub-agents deliberately survive. Rationale in `AppTaskProcessor` and `AgentPool`.
- **App → Monitor**: App agent's `relay` tool enqueues a `type: 'monitor'` task. App agent responses are also pushed to `InteractionTimeline` and drained by the monitor on its next turn.

### Sub-agents (`yaar://apps/self/agents`)

An app that declares `"subagents": { "max": N }` in its app.json may spawn up to N AI instances,
each with a runtime-supplied system prompt and its own provider session/memory. The verb surface is
`handlers/apps/agents-resource.ts` (`list` / `invoke {spawn|message|interrupt}` / `read` /
`delete`), callable only from the app's own iframe. `message` returns as soon as the turn is
queued; answers arrive on `yaar://agents/{instanceId}/stream` (needs `"streams": ["agents"]`).

The containment rules, each documented in full at the named site:

- **No YAAR verbs, no permissions, no principal.** A spawn with no `tools` gets `allowedTools: []` — that empty array is the whole containment story, since `undefined` would mean *every* tool. Sub-agents bypass `ContextPool` entirely.
- **The only capability is a reach back into the owning app's own iframe** (`agents/profiles/sub-agent.ts`): each declared tool becomes one `persona:{name}` app-protocol command, `personaId` stamped last. Grants to the app *agent* (`controls`, `direct_message`) do not descend.
- **`subagents`/`streams` are granted by the user at install time** and applied as a ceiling by intersection with the recorded grant — `features/apps/capabilities.ts` / `storage/app-grants.ts`. `controls` stays bundled-only.
- **One manifest key**: the `"personas"` alias is retired and refused by name; the **wire** still says `personaId` — `agents-resource.ts` is the one place the two spellings meet.

`subAgentKey(monitorId, appId, subId)` extends the app agent's key, which extends the monitor's —
session → monitor → app → sub-agent is one tree, addressed through the owner and torn down with it.
See [`docs/architecture/agent_tree.md`](../../../docs/architecture/agent_tree.md) for the four laws
every new node must satisfy and the triage rule for placing one.

## Self-update (`features/update/`)

`yaar://system/update` is how YAAR learns about and installs its own releases; the Configurations
app's **Updates** tab is the one consumer. Four files: `semver.ts` (comparison), `release.ts`
(GitHub `/releases/latest`, asset naming, `SHA256SUMS` parsing), `installer.ts` (download, verify,
swap), `updater.ts` (status + orchestration).

The load-bearing rules — each explained in `updater.ts`'s and `installer.ts`'s headers: `read`
never hits the network (only `invoke {action:'check'}` does, behind a 5-minute cache);
`install` returns once the work has *started*, with refusals thrown synchronously; a missing or
mismatched `SHA256SUMS` is a **hard** failure (unlike install.sh's warn-and-continue); staging is
a sibling of `process.execPath`, never `os.tmpdir()` (the swap is `rename(2)`);
`getUpdateStatus()` reports the *first* blocker. Installing never restarts the server; the
previous binary is left beside the new one as `yaar.previous`.

Adding `system` to `YaarAuthority` (`packages/shared/src/yaar-uri.ts`) is what makes the URI
resolvable — `resolveUri`'s fallback and its bare-authority regex both list it, alongside `skills`
and `mcp`, as an authority with no dedicated parser.
