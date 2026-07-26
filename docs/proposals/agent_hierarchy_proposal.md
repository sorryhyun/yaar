# Proposal: The Agent Tree — sub-agents as the general shape of multi-agent apps

**Status:** Redesign, around an explicit hierarchy, of the persona-agents proposal that came
before it — that document has been deleted, having shipped in full: its primitive is landed and
is, in this document's terms, a tool-less app-tier sub-agent, and its ChitChats port is
`apps/chitchats`. This document is now the standing design record for the whole tree.
It names the tree the code already runs, states its laws, and specifies the shape
any future multi-agent capability must take, so the next request ("can my app have a judge
with read access?", "can the monitor spawn helpers?") is answered by placing a node in the
tree rather than by designing a new pool tier from scratch.

| This document's phases | State |
|---|---|
| Phase 0 — docs: the four laws, the tree, the triage rule | **landed** |
| Phase 1 — `kind` discriminator, `SubAgent`/`subAgents`/`subId`, tree-shaped roster | **landed** |
| Phase 2 — `subagents` manifest alias, `grade` spawn param, the `protocol` grade | landed, then **collapsed** — see [Amendment](#amendment-the-menu-collapses-to-one-entry) |
| Phase 3 — ephemeral fold-in, budget split (`MAX_SUBAGENTS`) | not started; opportunistic |

> **Read the [Amendment](#amendment-the-menu-collapses-to-one-entry) before Part 2.** The grade
> menu shipped and was then reduced to a single capability set: the two grades differed only
> in whether the tool list was empty, so `grade` and the `grades` manifest field are gone.
> Part 2 below is kept as the record of why the menu was built and what it cost — it no longer
> describes the code.

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
downward. Personas are the tool-less, caller-prompted case of a sub-agent. The redesign makes
the tree the unit of design: one set of laws, one place capabilities are written, and a slot at
every tier for future growth.

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
   its full toolset; a sub-agent holds no principal and, at most, a named subset of the
   protocol commands its owner could already issue — often nothing at all. Cross-app grants
   (`controls`, `direct_message`) never
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
| sub-agent | `monitorId::appId::subId` | **runtime, verbatim** | one channel to its own iframe, under app-declared tool names — or nothing | owning app, `yaar://apps/self/agents` | `subAgents` |

One anomaly the table exposes: **ephemeral agents** are monitor-tier helpers that predate
the model — spawned only as a busy-monitor fallback (`createEphemeral()`, called solely from
`monitor-task-processor.ts`), reusing the monitor's own profile, keyed by nothing. In tree
terms they are monitor-tier sub-agents with a degenerate capability set ("same as owner"). Folding them
in is Phase 3 material, not v1 — but the tree already has their slot, which is the argument
for the tree.

## Amendment: the menu collapses to one entry

Phase 2 shipped a two-entry grade menu (`compute`, `protocol`) and a `grade` spawn param
gated on a `grades` list in the manifest. It has since been reduced to **one capability set**:
`grade`, `grades`, `SubAgentKind`, `GRADE_TO_KIND`, and the separate `compute` profile
(`agents/profiles/persona.ts`) are gone. A sub-agent is spawned with `tools` or without them,
and `agents/profiles/sub-agent.ts` holds the single profile builder.

**Why.** The two grades were the same profile with a different argument. `buildPersonaProfile`
returned `allowedTools: []`; `buildProtocolSubAgentProfile` returned
`tools.map(subAgentToolName)`, which for an empty list *is* `[]`. Every other field matched.
The menu was therefore a menu of one function with one parameter, and the `grade` param, the
`grades` manifest field, the kind discriminator, the two role prefixes, and the two spawn
paths existed to select between two values of that parameter. No shipping app passed `grade`.

**What was traded away, explicitly.** The manifest no longer records whether an app's
sub-agents can have hands. `"personas": { "max": 4 }` used to parse to `grades: ["compute"]`
and made "this app's characters are tool-less" checkable from app.json alone; now `{ max: 4 }`
permits both, and `apps/personas` (Round Table, still tool-less in fact) is *permitted* to
declare tools at spawn. Law 3 survives — capabilities are still written once in
`agents/profiles/` and never composed at the call site — but its install-time half is now
enforced only by the shape of what a caller may pass (names over one bridge), not by a
per-app declaration. If a future app needs "characters that provably cannot act", the way
back is not to restore grades but to make the manifest field a **tool allowlist**, which is
the thing an app author would actually want to write.

**What is unchanged.** The reach itself, and every law. A sub-agent still holds no principal,
no YAAR verbs, and no cross-app grants; its tools are still `mcp__subagent__*` only, still
land in its owning app's own iframe as `persona:{name}`, still carry a server-stamped
`personaId`, and are still a strict subset of what the app agent above it could issue. The
`app-persona-` role prefix is now the single one, so `isSubAgentRole` tests one string and
the restore filter behaves exactly as before.

## Design

### Part 1 — name the shape in code (mechanical, no behavior change) — **landed**

The landed `PersonaAgent` record already carried `{monitorId, appId, personaId}` as fields
with an opaque key — the exact record shape the multi-window proposal §2 wants. Part 1 was
recognition, not construction:

- `SubAgent` is the record type, in `agents/agent-pool.ts`. (Phase 2 briefly made it a
  union discriminated by `kind`; the Amendment collapsed it back to one interface.)
- `personaAgents` map → `subAgents`, `personaSpawns` → `subAgentSpawns` — same key scheme,
  same atomic spawn-reservation machinery. `personaAgentKey` → `subAgentKey`.
- Pool methods are `spawnSubAgent`, `runSubAgentTurn`, `getSubAgent`, `listSubAgents`,
  `disposeSubAgent(sForApp|sForMonitor)`. The `…Persona…` spellings were kept as one-line
  aliases through Phase 2 and removed with the Amendment, having acquired no callers.
- The record's id field is `subId`, not `personaId`. The
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

### Part 2 — the grade menu (the actual generalization) — **landed, then superseded**

The manifest generalizes, with the shipped field as a permanent alias:

```json
{ "subagents": { "max": 4, "grades": ["compute"] } }
```

`"personas": { "max": N }` ≡ `"subagents": { "max": N, "grades": ["compute"] }`, forever —
it is shipped wire format. Both parse in `features/apps/discovery.ts`, bundled-only, exactly
as today, and normalize to **one** internal field (`AppMeta.subagents`) so no consumer has to
know which spelling an app used. An unknown grade name is dropped rather than rejected: a
manifest on disk outlives any one YAAR build, and naming a grade this build doesn't have
should cost that grade, not the app's whole cast.

Each grade is one profile builder in `agents/profiles/` — written once, at install time of
*YAAR*, not of the app. Spawn selects by name and refuses grades absent from the manifest:

| Grade | Hands | Principal | Gate | Status |
|---|---|---|---|---|
| `compute` | none — receives text, returns text | none | bundled + manifest | **shipped** (today's persona) |
| `protocol` | exactly one channel: dispatch to the **owning app's iframe** through the app-protocol bridge, dressed as app-defined tools (`skip`, `excuse`, `recall`, `memorize`, …) | none | bundled + manifest | **shipped** (`profiles/sub-agent.ts` + `mcp/sub-agent/`); `apps/chitchats` is the first consumer |

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
  The handler side still lives in the protocol: the iframe registers `persona:{toolName}`
  commands, and `features/apps/persona-commands.ts` hides those entries from every
  agent-facing manifest — at the disk read (`discovery.ts`, which covers `describe`, the
  skill doc, and the HINT/manifest injections) and at the live manifest query
  (`handleAppQuery`). The prefix carries the audience flag rather than an
  `audience: "persona"` field on `AppCommandDescriptor`: it needs no shared-type,
  compiler, or SDK change, and the filter is one predicate instead of a schema. The
  server stamps `personaId` into every dispatched payload, **last**, so it wins over an
  argument of the same name — the iframe must know which character is remembering, and a
  model that can name one could otherwise write another's.
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
  mirror the prompt guard: `MAX_SUB_AGENT_TOOLS` (12) and `MAX_SUB_AGENT_TOOL_CHARS`
  (6 000) across names, descriptions, and parameter descriptions —
  `MAX_PERSONA_PROMPT_CHARS`'s siblings, and for the same reason (tool definitions are
  replayed every turn). Unlike the app agent's cross-app path, a tool call **never
  launches** a window: "the app isn't on screen" is not an invitation to put it there
  because a character decided to remember something.
- **Subsumes the earlier sketches.** A previous draft of this table carried `reader` and
  `worker` grades that borrowed subsets of YAAR verbs. Every use case they served ("read
  my own state", "operate my own window") is expressible as an app-defined tool with the
  iframe as executor, at strictly smaller YAAR surface — the app writes the handler and
  decides what "operate" means. They are dropped from the menu.

#### What Phase 2 actually landed, where it differs from the sketch above

*(Superseded by the [Amendment](#amendment-the-menu-collapses-to-one-entry) — this subsection
describes the two-grade code as it shipped, not as it stands.)*

- **The grade menu is one module.** `agents/profiles/sub-agent.ts` holds the grade
  names, the grade→kind map, the tool-spec parser and its caps, the `protocol` role
  prefix, and both profile builders. `buildSubAgentProfile(record)` is the menu lookup,
  and **every** sub-agent turn goes through it (`AgentPool.runSubAgentTurn` reads the
  turn's `allowedTools` and prompt off the profile). The menu is therefore load-bearing
  on every turn rather than documentation: the pool has no branch that assembles a tool
  list, and a new grade cannot be reached without adding a case to that switch.
- **Two spellings, one mapping.** The wire says `grade` (`compute` | `protocol`); the
  pool record says `kind` (`persona` | `protocol`). They differ for exactly one entry,
  because "persona" is shipped vocabulary — the URI segment, the spawn param, the
  `app-persona-` role prefix. `GRADE_TO_KIND`/`gradeOfKind` are the only translation,
  next to `subId`↔`personaId` in spirit but not in place (that one stays in
  `handlers/apps/agents-resource.ts`).
- **A `subagent` MCP namespace.** The `protocol` grade needs per-agent tools, and MCP
  servers are built per (namespace, client session) inside `runWithAgentContext` — so
  `mcp/sub-agent/` resolves the caller's record (`AgentPool.findSubAgentForAgent`, keyed
  off the agent *token*, never a claim) and registers exactly that record's tools. It is
  the only namespace in YAAR whose tool list depends on who is connecting; for everyone
  else it registers nothing, and nobody else's allowlist names it, so nobody else even
  connects it. `CORE_SERVERS` grew one entry.
- **A sibling role prefix, registered with all three consumers.** `app-protocol-`
  (law 3's requirement, met literally): `assembleSystemPromptForRole` returns it verbatim
  because it is under `app-`, `principalRole()` files it in the `app` tier, and the
  restore filter now asks `isSubAgentRole` — which knows both prefixes — where it used to
  ask `isPersonaRole`. A grade whose turns leaked into the monitor's restored context
  would replay a room's improv as the user talking.
- **The pool generalized without renaming its API.** `spawnSubAgent`, `runSubAgentTurn`,
  `getSubAgent`, `listSubAgents`, `disposeSubAgent(sForApp|sForMonitor)` are the
  grade-generic methods; the `…Persona…` names remain as one-line spellings of them, so
  the shipped persona suite passes with no assertion changed. One cap, one sweep, one
  limiter slot per node, whatever the grade.
- **It landed before its consumer.** The capability shipped on its tests — the loopback
  suite (`loopback-subagent-protocol.test.ts`) drives a real tool call through the real
  bridge into a real iframe response — and `apps/chitchats` arrived after, spawning its
  characters with a `skip` tool and answering `persona:skip` from its own iframe. Nothing
  further was needed from the server, which was the claim.

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
- **Phase 2 — landed:** `subagents` manifest alias + `grade` spawn param + the `protocol`
  grade, its profile builder, the `subagent` MCP namespace, the `persona:` command
  convention, and the tests. It landed *without* its consumer — the capability is inert
  until an app declares the grade, so waiting for the ChitChats port would have been
  waiting for nothing. Wire and behavior for every existing app are unchanged.
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
- Phase 2 (done, then amended), in two files. `src/tests/sub-agent.test.ts` — the role (`app`
  tier, prompt untouched, `isSubAgentRole`); the profile, both ways (declared tools become
  `mcp__subagent__*`; no tools becomes `[]`, never `undefined`); reach, twice — through the
  real `buildSDKOptions` (one MCP server, `subagent`, and no builtins; *zero* servers when
  tool-less) and on a live turn of a sub-agent whose owning app declares `controls`, which
  must not descend; tool-spec validation and caps; the manifest gate (`personas` reads as the
  ceiling; a malformed tool list is refused without spending an agent slot; an app that
  declared no ceiling is refused outright); one cap and one sweep shared whether or not there
  are tools; the tree placement. `src/tests/loopback/loopback-subagent-protocol.test.ts` — the round
  trip through the real bridge: `persona:{tool}` reaches the iframe stamped with
  `personaId` (and the stamp wins over a forged argument), a no-arg tool arrives as the
  signal it is, a silent app and a closed window come back as tool *errors* rather than a
  dead turn, and the app agent's manifest omits the persona-audience commands.
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

1. **Will any grade ever need real YAAR verbs?** (Still open, and still the tripwire — the
   `protocol` grade shipped without needing one.) ChitChats' `skip` is the first consumer
   and wanted nothing more; its character memory (`memorize`/`recall`) is unwritten and is
   the next test of the question, since both are app handlers over appDb rather than YAAR
   verbs. The channel covers every "persona with tools" case on the table by routing
   through the app. If a case ever genuinely needs YAAR verbs in a sub-agent's
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
