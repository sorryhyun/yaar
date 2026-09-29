# Proposal: External Window Access — an outside agent drives a window the user shared

**Status:** proposed (2026-09-29). Nothing below exists in the tree yet; every "today" claim
carries the file:line it was read at.

An agent outside YAAR — a Claude Code session in some repo, a Codex thread, another machine's
YAAR — is the same kind of model as YAAR's own monitor and app agents. Today it cannot touch a
YAAR app at all: the app protocol is reachable only by agents YAAR spawned. This proposal lets
an outside MCP client reach **exactly the windows the user shared with it**, through the **same
`yaar://windows/{w}` URIs** YAAR's own agents use, under a new `external` principal whose whole
authority is that set of shares.

The one-line design: **the address is shared, the authority is not.** An internal agent and an
external client read `yaar://windows/notes/state/doc` with the same spelling; what differs is
who is asking, and the access gate that already decides `yaar://session/*` by principal decides
this too.

---

## 1. Why

- **The app protocol is the valuable surface.** A YAAR app's `protocol.json` is a typed,
  documented, agent-facing API over a live UI — state keys to read, commands to run. An agent
  in a code repo that could `invoke yaar://windows/excel/commands/setCells` gets a spreadsheet
  the user is looking at, not a CSV it has to describe in prose.
- **Nothing outside can reach it.** The MCP endpoint's bearer token is minted at startup and
  handed only to spawned providers (`mcp/server.ts:210`, `providers/claude/sdk-options.ts:70`,
  Codex via `YAAR_MCP_TOKEN` in `providers/codex/app-server.ts:356`).
- **Remote Control is the other direction.** `features/remote-control.ts` puts YAAR's *own*
  monitor agent on claude.ai — an outside human talks to YAAR's agent. Here an outside *agent*
  skips YAAR's agent and talks to the app. They compose; neither replaces the other.

## 2. What already exists

Most of the work is gating, not building.

| Need | Already there |
|---|---|
| The API surface | `handlers/window.ts`: `describe`/`list`/`read` on `yaar://windows/{w}`, `read yaar://windows/{w}/state/{k}`, `invoke yaar://windows/{w}/commands/{k}` (`:100-109`, `:542-587`, `:1041`). Documented in `docs/reference/uri_reference.md:152-177`. |
| One access chokepoint both doors end at | `ResourceRegistry.execute`, `handlers/uri-registry.ts:250-256` — MCP `exec` and `POST /api/verb` both land here, batches re-enter it per element (`:408`). |
| Window-lifetime authority | `WindowSideState.grants` (`session/window-state.ts:100-112`): "the single home of window-scoped authority … authority dies with its window", deleted by the one `window.close` path (`:430`). |
| A permission modal with "remember" | `actionEmitter.showPermissionDialogToSession` (`session/action-emitter.ts:859`), keyed `toolName:context` into `config/permissions.json`; Remote Control is the precedent for "let an outsider in" (`features/remote-control.ts:68-76`). |
| A hand-built non-agent principal | The iframe door builds a context from a validated token (`http/routes/verb.ts:528-545`) — the template for an external one. |
| A way to tell the monitor agent | `ContextPool.timelineFor(monitorId).pushRaw(...)` (`agents/interaction-timeline.ts:84-86`), drained into `<timeline>` on its next turn. |
| A host with no user tab | The companion tab answers app requests when no user tab can (`session/app-window-coordinator.ts:305-315`). |

## 3. Design principle: same URI, different principal

The first sketch of this was a separate `external` MCP namespace with its own
`app_describe`/`app_query`/`app_command` tools. Rejected, because:

- **It is a second manual.** Every app's agent docs, every `describe` result and every URI
  stamped onto a manifest key (`enrichManifestWithUris`) already speaks `yaar://windows/…`. A
  parallel tool set would drift from them the way the storage doors did before they were split
  on purpose.
- **YAAR already separates address from authority.** `yaar://session/*` is spelled the same for
  every caller; `ResourceRegistry.execute` admits only the session principal. An external grant
  is one more rule at the same place, not a new place.

So the external client connects to the existing **`verbs`** namespace and nothing else.

## 4. Design

### 4.1 Two objects, two lifetimes

| Object | Lifetime | Stored in |
|---|---|---|
| **External client**: `{ clientId, name, keyHash, pairedAt, lastSeen }` | durable — survives restarts, revoked explicitly | `config/external-clients.json` (new, via `createPersistedStore`) |
| **Window share**: `{ clientId, level: 'read' \| 'operate', grantedAt }` | the window's — dies on close | a new `externalShares` field on `WindowSideState` |

The share goes on the side state rather than being keyed by URI. That is what solves **window-id
reuse**: `deriveWindowId` returns the `appId` itself (`features/window/helpers.ts:46-54`), so
closing and reopening Notes yields `notes` again. A share keyed by the string
`yaar://windows/notes` would silently cover the reopened window. Side state is deleted on close
and a new window starts empty, so the share has the instance's lifetime by construction, with no
nonce to mint.

One caveat: side state filed *before* a window exists is adopted by the next create
(`adoptPreCreateState`). A share must therefore be granted only on a window that exists at grant
time. Both paths in §4.3 do that.

### 4.2 Pairing — a bearer the client holds from the start

**Why not an in-band `__requestPermissions` tool.** The endpoint serves only the stateless
2026-07-28 era (`mcp/server.ts` header): there is no session id, and nothing survives between
two requests except what the client presents on each. A tool call could show the modal, but the
approval would have nothing to attach to. Handing a token back in the tool result doesn't work
either, because an MCP client cannot change its own headers mid-session. So the approval has to
bind to a credential the client **already sends**.

**MVP: the desktop mints the key.**

1. The user opens *Connect an external agent* (Configurations app, and linked from the share
   popover in §4.3), types a name (`claude-code @ yaar-repo`), and gets a key once, as a
   ready-to-paste command:
   ```
   claude mcp add --transport http yaar http://127.0.0.1:8000/mcp/verbs \
     --header "Authorization: Bearer yx_…"
   ```
2. `mcp/server.ts` bearer check (`:237-243`) becomes three-way: the internal `mcpToken` →
   today's path unchanged; a key whose hash is in `external-clients.json` → external
   principal; anything else → 401.
3. The key is stored hashed and shown once. Revoking it is deleting the entry.

No unauthenticated request can ever pop a dialog, which matters because `/mcp/*` is exempt from
remote-mode auth and reachable through the tunnel (`http/auth.ts:63-64`).

**Later (open question):** client-initiated pairing (unknown bearer + `X-Yaar-Client-Name` →
modal), loopback-only and one pending at a time; or MCP's own OAuth flow with YAAR's dialog as
the consent screen, so a bare `claude mcp add` works with no header.

### 4.3 Sharing a window

**User-initiated (primary).** A share affordance in the window chrome. There is no window
context menu today (`components/window/WindowFrame.tsx:255-354`; the only `onContextMenu` is the
content area's "Ask AI", `:367-374`), so this is a new titlebar button or popover: pick a paired
client and a level (`read` / `operate`), done. The user pointing at the window *is* the
approval, so no modal. It needs a new client event (or a REST call). It should not be a new
`UserInteraction` type, since that union is closed and means "the user moved a window"
(`packages/shared/src/events/client.ts:10-18`).

**Client-initiated (the modal path).** An external client that wants something it wasn't given
asks for it:

```
invoke('yaar://windows/', { action: 'request', appId: 'notes', level: 'operate' })
```

→ `showPermissionDialogToSession` with `title: "claude-code wants to operate Notes"`,
`toolName: 'external_window'`, `context: '<clientId>:<appId>'`, and `capabilities` rows spelling
out the level. On allow, the share is granted on the open instance (on the active monitor if
there are several). "Remember" saves `external_window:<clientId>:<appId>`, and a remembered
allow **auto-shares future instances of that app** with that client as they open — the one
place a share outlives a window, and only because the user said so in words.

Two dialog facts shape this (`action-emitter.ts:859-898`, `config/deadlines.ts:57-60,127`):
the dialog times out to *deny* after 60s (max 240s), and with no tab connected it is delivered
to nobody and simply waits that out. It is also not recorded, so a tab that connects later never
sees it. The request should fail fast with "nobody is at the desktop" (`isUserWatching`,
`session/client-presence.ts:71-80`) instead of blocking for a minute.

### 4.4 The principal and the gate

**Context.** An external request runs in
`runWithAgentContext({ agentId: 'external:<clientId>', role: 'external', sessionId: default, external: { clientId } })`.
Two traps from the reading:

- `role` must be a **new tier**, not `undefined`. Today an unresolved caller gets `role`,
  `monitorId` and `windowId` all undefined (`mcp/server.ts:260-265`), and `mayDelegateGrants()`
  answers **true** for that shape (`features/window/delegated-grants.ts:102-104`). An external
  client could then delegate storage grants by naming `yaar://storage/…` in a command payload.
  `mayDelegateGrants` must return false for `external`, and `principalRole` must learn the new
  prefix (it defaults unknown shapes to `monitor`, `agents/roles.ts:88-92`).
- `runWithAgentContext` copies fields one by one (`agents/agent-context.ts:164-178`), so a new
  `external` field has to be added there or it vanishes silently.

**Namespace.** An external bearer reaches `verbs` only. `system`, `app`, `messaging` and
`subagent` return 403.

**The gate** goes in `ResourceRegistry.execute`, right after the session-principal check
(`uri-registry.ts:256`) and **before** the trailing-slash re-dispatch and verb fallbacks
(`:261-304`), which recurse with rewritten URIs. For an external principal it is default-deny:

| URI | Verbs allowed | Needs |
|---|---|---|
| `yaar://windows` | `list`, `describe`; `invoke {action:'request'}` | paired |
| `yaar://windows/{w}` | `describe`, `list`, `read` | share ≥ `read` |
| `yaar://windows/{w}/state/{k}` | `describe`, `read` | share ≥ `read` |
| `yaar://windows/{w}/commands/{k}` | `describe` | share ≥ `read` |
| `yaar://windows/{w}/commands/{k}` | `invoke` | share = `operate` |
| `yaar://windows/{w}/history[/{seq}]` | `list`, `read` | share ≥ `read` |
| **everything else** | — | refused |

These are refused **even on a shared window**:

- `invoke` on the bare window URI, i.e. the whole `defineActions` table: `update`, `close`,
  `move`, `resize`, `lock`, `app_eval`, `message`, `subscribe`, … (`handlers/window.ts:306-355`).
  `app_query`/`app_command` duplicate the sub-path spellings, so one spelling is enough.
- `app_eval`, which is arbitrary JS in the app.
- `delete` on anything, and history `restore`.

"Reach the app protocol and nothing else" is exactly the sub-path rows above.

The refusal text should name the reason ("outside what *claude-code* was shared: only windows
shared with it are reachable") rather than "not found". Results routinely carry URIs the client
cannot follow, such as `yaar://apps/{id}/storage/…`, and a model that reads "not found" goes
looking for a typo.

**Listing and resolution.** `list('yaar://windows/')` with no monitor in context lists **every
monitor's** windows (`handlers/window.ts:277`, `session/window-state.ts:645-654`). For an
external principal it lists **only the windows shared with it**, plus a one-line note on how to
request more. Resolving a raw id with no monitor works only when the id is open on exactly one
monitor (`session/window-handle-map.ts:85-94`), and the handle form `yaar://windows/0/notes`
does not parse as one (`packages/shared/src/yaar-uri.ts:298-306`). So for an external principal
the **share table is the resolver**: raw id → the one shared handle. v1 refuses to share a
second window with the same raw id to the same client, with a message to unshare the first.

### 4.5 Visibility — the user sees what an outsider does

- **Window chrome:** a *shared with claude-code* badge beside the lock badge
  (`WindowFrame.tsx:261-288`); clicking it revokes.
- **The monitor agent's timeline:** after each external `commands/*` invoke, push
  `<external client="claude-code" window="notes">ran commands/save</external>` through
  `pool.timelineFor(monitorId).pushRaw` (next to `recordAppCommand`,
  `features/window/app-protocol.ts:624-633`). Also call `pool.notifyWindowSubscribers` so an
  agent subscribed to that window hears it. Today a verb-driven command from a non-agent caller
  reaches nothing the monitor sees, since it emits no OS action. Reads are not pushed; they
  would only be noise. This closes the same gap Remote Control left open ("the remote agent's
  own actions are not pushed to the desktop timeline").
- **History attribution:** `recordAppCommand` already records an agentId, which becomes
  `external:<clientId>` instead of `unknown`.
- **Status bar chip (phase 3):** needs `'external'` in `AgentKind` and `agentKindFromRole`
  (`packages/shared/src/agent-kind.ts:32,47-53`), the hand-copied union in
  `agents/agent-roster.ts:67`, a `--agent-external` color, and **the server emitting
  `TOOL_PROGRESS`/`AGENT_RESPONSE` around each external call**. The bar only knows agents that
  stream (`server-event-dispatcher.ts:189-252`).

### 4.6 Hosting — an app needs a page

An app's state lives in its iframe, so "running a YAAR app from outside" really means *driving a
YAAR window from outside*. Some browser page has to host it:

- **A user tab**: normal case. Minimized windows and windows on other monitors keep answering,
  because every iframe window is mounted on every monitor (`WindowManager.tsx:33-47`).
- **The companion tab** (`YAAR_COMPANION_TAB=1`): the headless case. It hosts every monitor's
  windows in desktop layout and ranks as a fallback responder (`app-window-coordinator.ts:305-315`).
- **Nothing**: the request fails as "App did not register with the App Protocol (timeout)"
  (`app-protocol.ts:162-169`). The external error should say "no desktop is hosting this
  window" instead.

v1 has no way for an external client to *open* a window. Headless use therefore means windows
the user shared earlier, or restored windows with a remembered per-app share (§4.3).

### 4.7 Protocol era

The endpoint refuses anything that isn't 2026-07-28 (`refuseLegacyEra`, `mcp/server.ts:84-95`).
An external Claude Code needs the same pair YAAR sets on its own spawns,
`MCP_SDK_GENERATION=v2` and `MCP_PROTOCOL_NEGOTIATION=auto` (`config/providers/claude.ts:130-131`).
Codex needs `features.mcp_2026_07_28=true`. The connect snippet in §4.2 must print these.
Whether an **interactive** `claude` honors the pair the way the SDK spawn does is unverified; it
is the first thing the spike checks. Clients that cannot negotiate up (older desktop apps,
IDEs) are refused in v1 (see §8).

## 5. Changes by file

| File | Change |
|---|---|
| `mcp/server.ts` | Three-way bearer; external context; namespace restriction to `verbs` |
| `storage/external-clients.ts` (new) | Persisted client registry, hashed keys, `lastSeen` |
| `session/window-state.ts` | `externalShares` on `WindowSideState`; share/unshare/lookup; resolver by raw id per client |
| `agents/agent-context.ts`, `agents/roles.ts`, `packages/shared` role prefixes | `external` role, context field, `principalRole` branch |
| `handlers/uri-registry.ts` | `authorizeExternal` after the session-principal check |
| `handlers/window.ts` | External-filtered `list`; `request` action on the collection |
| `features/window/delegated-grants.ts` | `mayDelegateGrants` false for `external` |
| `features/window/app-protocol.ts` | Timeline push + subscriber notify after an external command |
| `features/external/` (new) | Pairing mint/revoke, request → dialog, remembered auto-share on `window.create` |
| `packages/shared` events | Share/unshare client event; share badge in window state snapshot |
| `packages/frontend` `WindowFrame.tsx` | Share popover + badge |
| `apps/` Configurations | *External agents* tab: connect (mint + snippet), list, revoke |
| `docs/reference/uri_reference.md`, new `docs/guides/external_agents.md` | The external tier and the connect walkthrough |

## 6. Found while reading: an existing bug

`delete('yaar://windows/X/history')` **closes window X.** `windowTarget` returns a `history`
kind (`handlers/window.ts:100-106`). The delete handler refuses `resource` and `invalid` kinds
but not `history`, so it falls through to `handleManage(…, 'close')` (`:1186-1205`). This is
independent of this proposal and worth fixing on its own. The external gate would refuse
`delete` anyway, but an internal agent can hit it today.

## 7. Non-goals (v1)

- **Opening, moving or closing windows** from outside. Placement needs a monitor, and v1 has no
  answer for which one.
- **Push.** No subscriptions or streams to an external client. The stateless era has no channel
  back, and `subscribe` requires a monitor (`features/window/subscribe.ts:29,94`). Clients poll
  `read`.
- **Anything but windows.** No storage, apps, http, browser, messaging or app agents. Files come
  through the app's own commands, which keep the app's invariants.
- **Talking to the app agent.** `message` is refused. An external client *replaces* the app
  agent for the calls it makes; it does not converse with it.
- **The 2025 protocol era** and **OAuth**.

## 8. Open questions

1. **Legacy-era clients.** Reopen a 2025-era stateful leg for external bearers only, so Claude
   Desktop and IDE clients can connect? It cost real complexity to delete (`mcp/server.ts`
   header). Recommendation: no until someone needs a specific client.
2. **Client-initiated pairing** (§4.2 "later"): worth its modal-spam surface on loopback?
3. **Remote mode.** An external key over the tunnel is as strong as the remote token, since
   `/mcp/*` skips remote auth and is tunnel-reachable. Should a key be optionally loopback-only?
   Behind Tailscale Serve every request arrives from 127.0.0.1, so that needs the proxy's
   headers, not the socket address.
4. **`read` level and `__screenshot`.** A read share exposes pixels of the window, which may be
   more than its state keys. Should screenshots be `operate`-only?
5. **Raw-id collisions** (§4.4): refuse, as proposed, or mint client-visible aliases
   (`notes`, `notes~2`)?

## 9. Phases

- **P0**: fix §6 on its own. *Done.*
- **P1 (spike)**: verify §4.7 with an interactive `claude`; external principal + gate +
  side-state shares + pairing via a dev-only mint route; timeline push. Done when an outside
  Claude Code reads and edits a shared Notes window, sees nothing else, and the monitor agent's
  next turn mentions it.
- **P2**: share popover + badge, Configurations tab, `request` → dialog with remembered
  per-app auto-share, the guide.
- **P3**: status-bar chip, OAuth pairing, answers to §8.
