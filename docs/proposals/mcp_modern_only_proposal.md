# Proposal: One MCP Protocol Era — Retiring the Stateful Leg

`mcp/server.ts` serves both MCP protocol eras off one endpoint. The 2026-07-28 revision is
strictly better for YAAR's shape — it is stateless, and YAAR's per-namespace server was already a
factory — but today it is **dead code in production**: neither provider negotiates up, so every
byte of real traffic rides the 2025-era stateful path.

This proposal turns that around: make both providers speak 2026-07-28, then delete the stateful
leg. It is worth stating the conclusion first, because it is not "delete it now":

> **The switch-on is safe and should happen immediately. The deletion is not, and is gated on
> exit criteria that are outside this repo's control.** Deleting the legacy leg converts today's
> *silent, working fallback* into a total tool outage for every agent, and the opt-in that gets
> Claude onto the modern path is two **undocumented** env vars in a CLI that YAAR does not pin.

---

## 1. What the stateful leg actually costs

Roughly 150 of `mcp/server.ts`'s 444 lines exist only to serve 2025-era clients, and they are not
150 boring lines:

| Machinery | Lines | Why it exists |
|---|---|---|
| `mcpSessions` map + `McpSessionEntry` | ~15 | Sessions must be found again by `mcp-session-id` |
| Idle eviction `setInterval` (`MCP_SESSION_TTL_MS`) | ~12 | Nothing else reclaims an abandoned session |
| `getOpenGetStream` + `STANDALONE_GET_STREAM_ID` + `StandaloneStreamHandle` | ~30 | **Reaches into the SDK-private `_streamMapping` field** to avoid evicting a session whose client still holds the GET common stream |
| `MCP_KEEPALIVE_MS` | ~20 (mostly the comment earning the number) | Bun closes idle sockets at 255s; the GET stream would otherwise be reconnected |
| Transport construction, `onsessioninitialized`, `onclose` | ~25 | Session registration and teardown |
| Session-404 branch, `initialize` validation branch, era classifier | ~45 | Dispatch |

Three of those are genuine liabilities rather than mere volume:

- **The SDK-private field access.** `getOpenGetStream` reads `transport._streamMapping`, verified
  by hand against `@modelcontextprotocol/server` 2.0.0 and, before it, `@modelcontextprotocol/sdk`
  1.29.0. It is guarded to degrade rather than throw, but it is a documented promise to re-verify
  on every SDK bump. The modern handler holds no stream and needs none of it.
- **The Bun idle-timeout interaction.** `MCP_KEEPALIVE_MS = 60s` is a deliberate margin under
  Bun's 255s `TRANSPORT_IDLE_TIMEOUT_S`. A stateless endpoint has no long-lived socket, so the
  coupling between YAAR's MCP layer and Bun's socket policy disappears outright.
- **Restart orphans sessions.** A server restart invalidates every `mcp-session-id`; clients get
  `-32000 Session not found` until they re-initialize. Stateless requests are self-contained and
  survive a restart with no reconnect handshake at all.

The port itself is close to free. `getModernHandler` already exists, already passes
`createServerForName` as its per-request factory, and is already pinned by
`tests/mcp-protocol-eras.test.ts`. Nothing new has to be written for the modern path to work — it
works today, on demand.

Orthogonal and unaffected: agent identity. `runWithAgentContext` is driven by the `x-agent-token`
header (`mcp/agent-tokens.ts`), which is per-request and era-agnostic. Statelessness does not
weaken the principal model — if anything it removes the last place a stale session could outlive
the agent it was minted for.

## 2. What switching on actually requires

Two one-line changes, at two seams that already exist.

**Claude** — `CLAUDE_ENV_OVERRIDES` in `config/providers/claude.ts`, which
`buildClaudeEnv()` layers onto the scrubbed parent env and `providers/claude/sdk-options.ts:98`
hands to every spawn:

```ts
MCP_SDK_GENERATION: 'v2',            // MCP TS SDK 2.x runtime arm (default: v1, 2025-era only)
MCP_PROTOCOL_NEGOTIATION: 'auto',    // per-transport negotiation (default: legacy)
```

Both are required; either alone is a no-op. `MCP_SDK_GENERATION` selects the runtime arm, and only
the v2 arm reads `MCP_PROTOCOL_NEGOTIATION` at all — which is why setting the negotiation var by
itself changes nothing observable. Neither name appears in `PARENT_HARNESS_ENV_VARS`, so no scrub
interaction to work around.

**Codex** — a feature flag in the app-server spawn args (`ENABLED_FEATURES` in
`config/providers/codex.ts`):

```ts
'-c', 'features.mcp_2026_07_28=true',
```

This was originally written as the `CODEX_MCP_PROTOCOL_VERSION: '2026-07-28'` spawn env var, on
the strength of the var name and revision string being present in the binary. Presence was not
behavior. Measured against `codex-cli 0.147.0` by pointing a real app-server at a probe MCP
endpoint and recording what it sent:

| spawn config | first request to the MCP server |
|---|---|
| env var only | `POST initialize`, `protocolVersion: 2025-06-18`, takes an `mcp-session-id`, opens the GET common stream, `tools/list` — **stateful 2025-era leg** |
| flag only (env var unset) | `POST server/discover`, `mcp-protocol-version: 2026-07-28`, no session id — **modern leg** |

So the flag is necessary and sufficient and the var is neither. The var is not a dead letter — it
is the **stdio** path's era selector, which its own refusal message says outright ("unsupported
`CODEX_MCP_PROTOCOL_VERSION` `…` for stdio MCP server; expected `2026-07-28`") — and YAAR's servers
are all HTTP. It is kept in the spawn env for the stdio case, not for this one.

Two consequences for this proposal. The flag's stage is `under development` (`codex features list`),
so the Codex opt-in is ahead of stabilization rather than merely undocumented — a stronger version
of the §3a risk, and one more reason the stateful fallback earns its keep. And Phase-2 telemetry
gathered before this correction measured the *old* config, in which Codex never left the legacy leg
at all; it says nothing about the modern one.

That is the whole switch-on. Everything else in this proposal is about whether it is safe to then
remove the other leg.

## 3. Why the deletion is the hard part

### 3a. The Claude gates are undocumented and unpinned

Neither `MCP_SDK_GENERATION` nor `MCP_PROTOCOL_NEGOTIATION` appears in the published env-var
reference, the MCP docs, the Agent SDK docs, or the `claude-code` changelog. They are internal
gates, additionally fronted by a server-side rollout flag (`tengu_brindle_causeway`) that can move
users onto the v2 arm without a release. Undocumented gates get renamed.

This compounds with how YAAR finds the binary. `resolveClaudeBinPath()` resolves
`CLAUDE_CODE_PATH` → bundled-exe sibling → `~/.local/bin/claude` → `PATH`. Only the bundled-exe
case is a version YAAR controls; in every other case the user's `claude` self-updates underneath
us. YAAR has no `CLAUDE_MIN_VERSION` gate — the Codex-style refusal machinery
(`providers/codex/version.ts`) has no Claude counterpart. So there is currently no mechanism that
would even *detect* the gate disappearing, let alone refuse to boot on it.

### 3b. Deletion turns a graceful fallback into an outage

This is the load-bearing objection. The modern client falls back to legacy `initialize` on a
`-32601`, on an HTTP error, and (stdio only) on close/timeout — silently, and it retries a version
mismatch exactly once. Today that means a bug in YAAR's modern handler costs nothing: the client
quietly re-handshakes and every tool keeps working.

Delete the legacy leg and that same bug — or a reverted CLI gate, or a stale `claude` on one
user's machine — refuses `initialize` and **every agent loses every tool at once**. There is no
partial degradation mode here; MCP is how verbs, app control, messaging, and sub-agents all reach
the server. The blast radius of being wrong is the entire product.

### 3c. Codex needs a floor raise, not just a var

`CODEX_MIN_VERSION` is `0.145.0`. The var is confirmed in 0.147.0 but its introduction version is
unverified. Modern-only means raising the floor to that version — which is a real user-facing
refusal (`assertSupportedCodex` refuses to drive an older CLI), so it needs the actual number, not
an assumption.

### 3d. Per-request server construction is unmeasured

Stateful builds one `McpServer` per session; stateless runs `createServerForName` on **every
request**, so every tool registration in `verbs`/`app`/`messaging` re-runs per tool call. The
handler is memoized, the factory is not. This is very likely fine — registration is synchronous
object-building — but "very likely fine" on the hot path of every agent action deserves a
measurement before it becomes the only path.

### 3e. Not in scope: YAAR as an MCP *client*

`mcp/external/client-manager.ts` consumes third-party MCP servers, most of which are 2025-era.
That client must keep its negotiating-with-fallback behavior. Nothing in this proposal touches it,
and it should not be "made consistent" with the server side.

## 4. Plan

**Phase 1 — switch both providers on. Keep both legs. — DONE.**
The two env changes in §2, plus the §5 doc fixes. The modern leg stops being dead code and starts
carrying production traffic, while the fallback still absorbs any failure. Fully reversible by
deleting the two lines.

**Phase 2 — make legacy loud, and prove modern in the real stack. — PARTIALLY DONE.**
Log the negotiated era per connection and count legacy connections, so "does modern actually land
in production?" is answered by data instead of by this document. Add a loopback row that spawns a
real provider and asserts it negotiated 2026-07-28 — the existing
`tests/mcp-protocol-eras.test.ts` proves the *server* serves both eras with a synthetic client;
what is missing is proof that the *shipped providers* choose the modern one. Measure §3d here.

*Landed:* the leg is marked deprecated and instrumented. Its machinery is fenced between
`BEGIN/END deprecated` banners in `mcp/server.ts` with `@deprecated` on every declaration inside;
`getMcpEraStats()` counts requests per era plus legacy sessions minted; the first legacy
connection per process logs a one-time `[MCP] DEPRECATED protocol era:` warning naming the client
that failed to negotiate up. `tests/mcp-protocol-eras.test.ts` now asserts a negotiating client
touches the legacy leg exactly zero times, so "no legacy traffic" is a pinned assertion rather
than an eyeballed log.

*Still open:* the loopback row that spawns a **real** provider and asserts the negotiated
revision — the counters prove the fork works under a synthetic client, not that the shipped
`claude`/`codex` binaries choose modern. And §3d is unmeasured.

**Phase 3 — delete the stateful leg.** Gated on all four:

1. The two Claude gates are documented, or default-on, or YAAR gains a `CLAUDE_MIN_VERSION`-style
   refusal that fails the boot loudly when the gate is gone (mirroring `providers/codex/version.ts`,
   which exists for exactly this class of problem).
2. `features.mcp_2026_07_28` reaches `stable` stage, **and** `CODEX_MIN_VERSION` is raised to the
   verified version that ships it that way. Deleting the fallback while the gate is still
   `under development` means a codex release can withdraw the flag and take every Codex tool call
   with it.
3. Phase-2 telemetry shows zero legacy connections across a meaningful window, including at least
   one bundled-exe release.
4. Per-request factory cost measured and accepted.

An optional reversible middle step, if phase 3 wants to be tried before criterion 1 lands: put the
legacy leg behind `YAAR_MCP_LEGACY` (default on), so it can be switched off for a release and
switched back on without a revert. That buys most of the confidence at none of the risk, and the
deletion becomes a formality afterward.

## 5. Docs that go stale at phase 1

Three places currently assert the modern leg is dormant, and all three become false the moment §2
lands:

- `packages/server/src/mcp/server.ts:15-17` — "Reached by clients that negotiate up, which for
  Codex means the `CODEX_MCP_PROTOCOL_VERSION` opt-in; YAAR does not set it, so this leg is dormant
  until a client asks for it." Both halves change: YAAR sets it, and Codex is no longer the only
  door — Claude has one too.
- `packages/server/CLAUDE.md:247` — "Codex reaches the modern leg only via its
  `CODEX_MCP_PROTOCOL_VERSION` opt-in, which YAAR does not set."
- Root `CLAUDE.md:146` — "the stateless 2026-07-28 revision for clients that negotiate up."

Worth fixing in the same commit as §2, since the whole point of those comments is to tell the next
reader which leg real traffic uses.
