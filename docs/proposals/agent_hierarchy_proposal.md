# Proposal: The Agent Tree — sub-agents as the general shape of multi-agent apps

**Status:** Redesign of [`persona_agents_proposal.md`](./persona_agents_proposal.md) around an
explicit hierarchy. Phase 1 of that proposal (the persona primitive) is landed and is, in
this document's terms, the `compute` grade of app-tier sub-agents — nothing shipped changes.
This document names the tree the code already runs, states its laws, and specifies the shape
any future multi-agent capability must take, so the next request ("can my app have a judge
with read access?", "can the monitor spawn helpers?") is answered by placing a node in the
tree rather than by designing a new pool tier from scratch.

| This document's phases | State |
|---|---|
| Phase 0 — docs: the four laws, the tree, the triage rule | **landed** |
| Phase 1 — `kind` discriminator, `SubAgent`/`subAgents`/`subId`, tree-shaped roster | **landed** |
| Phase 2 — `subagents` manifest alias, `grade` spawn param, the `protocol` grade | not started; gated on a consumer |
| Phase 3 — ephemeral fold-in, budget split (`MAX_SUBAGENTS`) | not started; opportunistic |

**Scope:** conceptual reframing (docs + light mechanical renames in `packages/server`);
optional generalization phases gated on real consumers.

## Summary

YAAR already runs a tree of agents; it just never says so:

```
session agent                        (1 per session)     cross-monitor oversight
└─ monitor agent                     (per monitor)       the desktop's hands
   └─ app agent                      (per monitor::app)  the process's main thread — the principal
      └─ sub-agents                  (per monitor::app::subId)  worker threads — no principal
```

Each tier's pool key extends its owner's key (`monitorId` → `monitorId::appId` →
`monitorId::appId::subId`), each tier is addressed *through* its owner, and disposal cascades
downward. Personas are the first **kind** of sub-agent — the tool-less, caller-prompted,
`compute` grade. The redesign makes the tree the unit of design: one set of laws, a fixed
menu of capability grades, and a slot at every tier for future growth.

In the OS metaphor the original proposal opened: processes got threads. This document writes
down the threading model.

## The four laws

These are the invariants the landed code already obeys. Stating them once is the point of
the redesign — every future node must satisfy all four, and a feature that can't is a
different feature.

1. **Ownership follows the key.** Every agent below the session tier has exactly one owner,
   one tier up, and its pool key extends the owner's key. Addressing goes through the owner —
   `yaar://apps/self/agents/{subId}` — and naming is not owning: the landed ownership check
   (appId-in-URI must equal appId-in-context, `handlers/apps/agents-resource.ts`) is the
   enforcement, and it generalizes to any tier. Nothing reaches across the tree; two monitors
   running the same app hold two disjoint subtrees.

2. **Descent never adds capability.** A child's capability set is a subset of its owner's,
   and each step down strips more than it keeps. The app agent holds the app's principal and
   its full toolset; a sub-agent holds no principal and whatever its *grade* leaves — for the
   shipped `compute` grade, nothing. Cross-app grants (`controls`, `direct_message`) never
   descend: they are grants to the process's main thread, not to the process.

3. **Prompts descend toward runtime; capabilities stay at install time.** Going down the
   tree, the system prompt becomes progressively more caller-supplied: the session and
   monitor prompts are YAAR's constants, the app agent's comes off disk at install
   (`AGENTS.md`/`SKILL.md`), a sub-agent's arrives verbatim at spawn. Capabilities move in
   the *opposite* direction: they are always a fixed menu written once in
   `agents/profiles/`, **selected** at spawn, never composed there. This is the law that
   answers "why not just allow multiple app agents with prompt overrides?" — overriding the
   prompt is safe *because* the hands are not overridable. A runtime string chooses from a
   menu; it never writes the menu.

4. **Lifecycle cascades down.** Disposing an owner disposes its subtree: monitor removal
   tears down its app agents and their sub-agents; the app's last window on a monitor
   closing tears down that app's sub-agents (asked of the window registry, not
   `activeWindows` — see the landed delta table). No node outlives its owner, and no node
   persists across sessions — durable identity is app data (`appDb`/`appStorage`), replayed
   into a fresh node's first turn.

## Current state, mapped onto the tree

| Tier | Key | Prompt provenance | Capabilities | Spawned by | Today's name |
|---|---|---|---|---|---|
| session | — (singleton) | constant | full session toolset | first message | `sessionAgent` |
| monitor | `monitorId` | constant + `HINT.md` injections | monitor toolset | monitor creation | `monitorAgents` |
| app | `monitorId::appId` | install-time disk (`AGENTS.md`/`SKILL.md`) | `describe`/`query`/`command`/`relay` (+`direct_message`, +`controls`), app principal | first window interaction | `appAgents` |
| sub-agent | `monitorId::appId::subId` | **runtime, verbatim** | grade menu (today: `compute` = none) | owning app, `yaar://apps/self/agents` | `subAgents` |

One anomaly the table exposes: **ephemeral agents** are monitor-tier helpers that predate
the model — spawned only as a busy-monitor fallback (`createEphemeral()`, called solely from
`monitor-task-processor.ts`), reusing the monitor's own profile, keyed by nothing. In tree
terms they are monitor-tier sub-agents of a degenerate grade ("same as owner"). Folding them
in is Phase 3 material, not v1 — but the tree already has their slot, which is the argument
for the tree.

## Design

### Part 1 — name the shape in code (mechanical, no behavior change) — **landed**

The landed `PersonaAgent` record already carried `{monitorId, appId, personaId}` as fields
with an opaque key — the exact record shape the multi-window proposal §2 wants. Part 1 was
recognition, not construction:

- `SubAgent` is the union of sub-agent kinds; `PersonaAgent` is its sole member, an
  interface carrying `kind: 'persona'` (the `compute` grade). Both are exported from
  `agents/agent-pool.ts`; every existing call site still says `PersonaAgent` and compiles
  unchanged. `SubAgentKind` is the grade menu's type.
- `personaAgents` map → `subAgents`, `personaSpawns` → `subAgentSpawns` — same key scheme,
  same atomic spawn-reservation machinery. `personaAgentKey` → `subAgentKey`, with the old
  name kept as an exported alias (the persona suite imports it).
- Method names on the pool (`spawnPersonaAgent`, `runPersonaTurn`, …) are unchanged:
  they are the `compute` grade's API, and a second grade adds siblings rather than
  renaming these.
- The record's id field is `subId`, not `personaId` — grade-neutral, since a
  `protocol`-grade sub-agent is no more a "persona" than the field it would inherit. The
  roster (`AgentEntry`) follows suit. The **wire** keeps `personaId` everywhere
  (`yaar://apps/self/agents/{personaId}`, the spawn param, every response body), and
  `handlers/apps/agents-resource.ts` is the single place the two spellings meet.
- `buildAgentTree(entries)` re-shapes the flat roster into the ownership tree;
  `AgentPool.agentTree()` is the pool-side accessor, and `list('yaar://session/agents')`
  now returns both views — `agents` (flat) and `tree` (nested). A tree node with
  `id: null` is a **vacant owner slot**: ownership follows the key, not the instance, so
  an app's sub-agents hang under `monitorId::appId` whether or not that app ever grew an
  agent of its own. `listAgents()` is otherwise untouched — the parentage was already in
  its `monitorId`/`appId`/`subId` fields.
- `AgentPoolStats` gained nothing: the `personaAgents` count stays (and is now also
  reported by the verb, which had omitted it); per-kind counts can come with a second kind.

Tests: `src/tests/agent-tree.test.ts` covers the tree shapes (including the vacant-slot
cases the live pool reaches rarely). The persona suite needed exactly two edits, both
reading the renamed record field (`p.subId`, `entry?.subId`); every behavioral assertion
— spawn/reuse/at-capacity/no-slot, tool-lessness, ownership refusals, teardown — is
untouched, and the wire-facing assertions still say `personaId`.

### Part 2 — the grade menu (the actual generalization; build on demand) — not started

The manifest generalizes, with the shipped field as a permanent alias:

```json
{ "subagents": { "max": 4, "grades": ["compute"] } }
```

`"personas": { "max": N }` ≡ `"subagents": { "max": N, "grades": ["compute"] }`, forever —
it is shipped wire format. Both parse in `features/apps/discovery.ts`, bundled-only, exactly
as today.

Each grade is one profile builder in `agents/profiles/` — written once, at install time of
*YAAR*, not of the app. Spawn selects by name and refuses grades absent from the manifest:

| Grade | Hands | Principal | Gate | Status |
|---|---|---|---|---|
| `compute` | none — receives text, returns text | none | bundled + manifest | **shipped** (today's persona) |
| `protocol` | exactly one channel: dispatch to the **owning app's iframe** through the app-protocol bridge, dressed as app-defined tools (`skip`, `excuse`, `recall`, `memorize`, …) | none | bundled + manifest | designed below; first named consumer is the ChitChats port (Phase 3's `[[skip]]` convention and memory tools) |

Rules that keep law 2 structural rather than aspirational:

- Every grade's reach is a **subset of the owning app agent's** — monotonicity by
  construction, not by review. For `protocol` this is literal: the app agent's `command`
  tool can dispatch *any* protocol command to the app's iframe; a `protocol`-grade
  sub-agent can dispatch only the commands its spawn declared.
- `spawn` gains `grade?: string`, default `'compute'`. Everything else on the verb surface —
  idempotent spawn, reject-if-busy with `busy: true` on the envelope, `done`-frame final
  text, `read` as the reconnect fallback, `delete` one-or-all — is grade-independent and
  stands exactly as landed.

#### The `protocol` grade — app-defined tools, app-mediated reach

```jsonc
invoke('yaar://apps/self/agents', {
  action: 'spawn', personaId: 'alice', grade: 'protocol', systemPrompt,
  tools: [
    { name: 'skip',     description: 'Decline this turn — you have nothing to add.' },
    { name: 'memorize', description: 'Save a lasting fact you learned about someone.',
      input: { fact: 'string' } },
    { name: 'recall',   description: 'Search your long-term memory for relevant facts.',
      input: { query: 'string' } },
  ],
})
```

- **The capability is singular and install-time.** The profile builder grants one reach:
  *send a payload to your own app's iframe and receive its reply*, over the same
  request/response bridge the app agent's `command` tool already uses
  (`features/window/app-protocol.ts` — `handleAppCommand`), targeting the owning app's
  active window. Tool names, descriptions, and schemas are runtime **prompt material** —
  costumes over that one channel. Law 3 holds with its terms sharpened: runtime text may
  shape what a sub-agent is *told*, never what it can *touch*.
- **Two audiences, two descriptions.** This is why the tool definitions arrive at spawn
  rather than being read out of `protocol.json`. The protocol manifest describes commands
  to the *app agent* in operator voice ("`persona_memorize` — write a character memory
  row"); the sub-agent needs character voice ("Save a lasting fact you learned about
  someone"). One description string cannot serve both without being wrong for one of them.
  The handler side still lives in the protocol (the iframe registers
  `persona:{toolName}` commands, or commands flagged `audience: "persona"`), and
  `describe` hides that flag's entries from the app agent's manifest so nobody reads the
  wrong script. The server stamps `personaId` into every dispatched payload — the iframe
  must know *which* character is remembering.
- **Why tools instead of output sentinels.** The original proposal's `[[skip]]` is a parse
  hoping to be a signal; a `skip` tool *is* the signal. And `recall` cannot be a sentinel
  at all — it needs a result fed back into the turn mid-generation, which only the tool
  loop provides. `skip`/`excuse` are fire-and-forget; `memorize` is a write the app
  acknowledges; `recall` is the round trip.
- **The trust boundary does not move.** The app already acts on every word the sub-agent
  streams; these tools structure that same channel and add a synchronous reply. The
  sub-agent still holds no principal, no YAAR verbs, no cross-app reach. Worst case, a
  hostile system prompt calls `memorize` with junk — and the app's own handler, running in
  the app's own sandbox with the app's own permissions, decides what junk means. That is
  the same exposure as rendering the sub-agent's text, which is why the gate stays
  manifest-only with no user permission prompt. (A future grade that borrowed actual YAAR
  verbs would be a different animal and would carry a user prompt — see open question 1.)
- **Failure shape.** No open window → the tool call returns an error result and the turn
  continues; the bridge timeout applies as it does for the app agent's `command`. Caps
  mirror the prompt guard: a max tool count and a max chars across names, descriptions,
  and schemas (`MAX_PERSONA_PROMPT_CHARS`'s sibling).
- **Subsumes the earlier sketches.** A previous draft of this table carried `reader` and
  `worker` grades that borrowed subsets of YAAR verbs. Every use case they served ("read
  my own state", "operate my own window") is expressible as an app-defined tool with the
  iframe as executor, at strictly smaller YAAR surface — the app writes the handler and
  decides what "operate" means. They are dropped from the menu.

**What deliberately does not exist at any grade:** YAAR tools at spawn — no grade lets a
runtime caller select verbs, `relay`, `direct_message`, `controls`, or `yaar://` access,
and none lets a sub-agent spawn sub-agents (the tree has four tiers, not N — a sub-agent
spawning sub-agents is an escalation ladder with no consumer and no owner semantics). The
`protocol` grade's spawn-time tool list is not an exception: every entry is a name over the
same single channel to the app's own iframe. Depth and reach are capped by design.

### Part 3 — the tree elsewhere (future slots, explicitly not v1)

- **Monitor-tier sub-agents.** Fold ephemerals into the model (`monitorId::*::subId`,
  grade "same-as-owner", spawned only by the fallback path as today). Separately, a monitor
  agent could plausibly want `compute` helpers for fan-out ("summarize these five windows
  concurrently") — the surface would be session-principal (`yaar://session/agents` grows a
  spawn action), the profile would be the same `compute` builder. Nothing needs inventing
  except the decision to want it.
- **Session-tier sub-agents.** Same argument, one tier up. No known consumer; the slot
  exists.
- **Budgets down the tree** (answers the original proposal's open question 5). `MAX_AGENTS`
  should count what it actually protects: provider processes with hands. Tree framing:
  each tier budgets its children — session caps monitors, `subagents.max` caps an app's
  children — and the *global* semaphore splits into `MAX_AGENTS` (principal-holding tiers)
  and a larger `MAX_SUBAGENTS` for sub-agent nodes — neither `compute` nor `protocol`
  holds YAAR tools, and both are materially lighter than an agent with hands. A
  4-character room then costs 3 + 4 against two pools instead of 7
  against one, and a second monitor stops competing with a chat room's cast.

## What does NOT change

- **Wire format and surface.** `"personas"` manifest field, every `yaar://apps/self/agents`
  URI and action, the stream gate (`streams: ["agents"]`), the ownership check, spawn
  idempotency, reject-if-busy. All landed, all stand.
- **Role strings.** The `app-persona-` prefix is load-bearing three ways —
  `assembleSystemPromptForRole` returns `app-` prompts verbatim, `principalRole()` maps
  them to the unprivileged `app` tier, and `isPersonaRole` keeps persona turns out of
  monitor context on restore (`logging/context-restore.ts`). The `compute` grade keeps the
  prefix byte-for-byte; a future grade mints a sibling prefix under `app-` and registers it
  with the same three consumers.
- **One principal per app.** The app agent remains the app's only principal holder. Grades
  above `compute` *borrow* a subset of that principal's reach for their turns; they never
  extend it, hold it, or survive it.
- **The monitor-scoping invariant.** Sub-agents belong to one monitor's subtree; no
  cross-monitor route exists at any tier.
- **`AppTaskProcessor`, steering, `activeWindows`.** Window interactions route to the app
  agent, uniquely, as today. Sub-agents are never interaction targets — only explicit
  `message` targets — which is what keeps "which agent gets the click?" unaskable.

## Migration

Phased so each step has value alone and none is forced:

- **Phase 0 (this document) — landed:** docs-only. The persona proposal points here; new
  multi-agent requests get triaged against the four laws.
- **Phase 1 (mechanical) — landed:** `kind` discriminator, `SubAgent` union, `subAgents`
  map, `subId` record field, tree-shaped `yaar://session/agents` output. No wire change, no
  behavior change; the persona suite's assertions are unchanged and `agent-tree.test.ts`
  pins the new shape.
- **Phase 2 (on demand) — not started:** `subagents` manifest alias + `grade` spawn param + the
  `protocol` grade, landing with its consumer (the ChitChats port, or `apps/personas`
  growing memory). The grade's profile builder, the persona-audience protocol flag, and a
  reach test (a `protocol` sub-agent's transport options carry exactly the one bridge
  tool set, nothing of YAAR's) land together.
- **Phase 3 (opportunistic) — not started:** ephemeral fold-in; budget split. Each is
  independently droppable.

## Testing

- Phase 1 (done): the landed persona suite was the regression net — spawn/reuse/at-capacity/
  no-slot, tool-lessness pinned against the real `buildSDKOptions`, ownership refusals,
  teardown on window close. It passes with no assertion changed (two lines follow the
  `personaId` → `subId` record rename). `agent-tree.test.ts` adds the tree
  shapes: nesting per tier, disjoint subtrees for two monitors running one app, vacant
  owner slots (app agent absent, monitor agent absent), ephemerals at the root, and a
  session entry that arrives out of roster order.
- Phase 2 additions (`protocol` grade) — not written: reach assertion — a `protocol` sub-agent's
  transport options carry the bridge tools it was spawned with and nothing else, even when
  the owning app declares `controls`/`direct_message`; manifest refusal (`grade` not
  declared → error naming the manifest); loopback — spawn with tools → tool call reaches
  the iframe stamped with `personaId` → reply lands as the tool result; `describe` from the
  app agent omits persona-audience commands; no-window and bridge-timeout tool calls return
  errors without killing the turn.
- Law tests — partly covered, per-tier rather than tier-generic. The persona suite already
  pins key uniqueness across all three scoping components ("persona key"), cascade disposal
  with slots freed ("reclaims personas when their monitor goes away", "releases every slot
  on pool cleanup"), and cross-subtree addressing refused (`scopes personas to their app and
  monitor`, "refuses an app naming another app's personas"); `agent-tree.test.ts` adds
  disjoint subtrees for two monitors running one app. A single property test asserting
  key-extends-owner over *every* map is still unwritten, and wants a second kind to be worth
  generalizing against.

## Alternatives considered

- **Multiple app agents with prompt overrides** (the question that prompted this redesign):
  keying is identical (`monitorId::appId::instanceId` either way), so the map is not the
  cost — the cost is that tool-lessness becomes a runtime flag on a shared type, checked at
  four sites (`buildSDKOptions` allowlist derivation, `AppTaskProcessor` routing, prompt
  assembly, restore filtering) instead of nailed shut in one profile. Every one of those
  branches is an accident waiting for a refactor. The tree keeps the distinction
  structural: different kind, different profile, no widening path.
- **A new pool tier per capability need** (the trajectory the codebase was on): each need
  adds a `personaAgents`-shaped map, verb surface, and teardown hook. Works, but the third
  tier of plumbing is the same code as the second with different nouns. The tree amortizes:
  new needs are new *grades* (a profile file) or new *slots* (an owner tier), not new
  plumbing.
- **Full generality — arbitrary tool lists at spawn:** maximal flexibility, and exactly the
  escalation surface law 3 exists to prevent. A runtime-supplied prompt that also picks its
  tools is a confused-deputy factory. Rejected permanently, not deferred.
- **Doing nothing** (personas stay a special case): cheapest today, and defensible — one
  kind, one consumer. The cost is paid at the *next* multi-agent request, designed from
  scratch against an undocumented invariant set. This proposal is mostly that documentation.

## Open questions

1. **Will any grade ever need real YAAR verbs?** The `protocol` grade has a named consumer
   (ChitChats memory + skip) and covers every "persona with tools" case on the table by
   routing through the app. If a case ever genuinely needs YAAR verbs in a sub-agent's
   hands — not reachable via an app handler — that grade would be a different animal:
   user permission prompt at first spawn, per-verb subset of the app agent's toolset,
   and its own proposal. Do not build it for symmetry; this question is the tripwire.
2. **Ephemeral fold-in: worth the churn?** It deletes a special case but touches the
   monitor busy-fallback path, which is load-bearing and boring. Phase 3, and only with a
   second reason to be in that code.
3. **Budget split (`MAX_SUBAGENTS`):** the tree answer to persona open question 5 — does it
   need its own env var, or does exempting `compute` nodes from `MAX_AGENTS` with a
   hardcoded ceiling suffice?
4. **Naming.** "Sub-agent" is this document's term; "persona" survives as the `compute`
   grade's friendly name and the wire format. Is that split livable, or should one name
   win everywhere user-facing?
5. **Codex parity** (inherited from the original, unchanged): Claude-first, Codex
   best-effort; the tree changes nothing about it.
