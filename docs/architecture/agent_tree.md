# The Agent Tree

YAAR runs a tree of agents. This document names it, states the invariants every node obeys,
and gives the rule for placing a new one — so the next multi-agent request ("can my app have a
judge with read access?", "can the monitor spawn helpers?") is answered by finding a slot in the
tree rather than by designing a new pool tier from scratch.

For the Session/Monitor/Window mental model see [`monitor_and_windows_guide.md`](./monitor_and_windows_guide.md);
for per-tier tools and message flow see [`common_flow.md`](./common_flow.md). The verb surface an
app uses to spawn its own sub-agents is in the [URI & Verb Reference](../reference/uri_reference.md#app-sub-agents--yaarappsselfagents),
and the how-to is in the [App Development Guide](../guides/app-development.md#sub-agents-personas).

## The shape

```
session agent                      (1 per session)            cross-monitor oversight
└─ monitor agent                   (per monitor)              the desktop's hands
   └─ app agent                    (per monitor::app)         the process's main thread — the principal
      └─ sub-agents                (per monitor::app::subId)  worker threads — no principal
```

Each tier's pool key extends its owner's (`monitorId` → `monitorId::appId` →
`monitorId::appId::subId`), each tier is addressed *through* its owner, and disposal cascades
downward. In the OS metaphor: processes got threads. A "persona" is the tool-less case of a
sub-agent — the name survives because it is the shipped wire format, not because it is a
separate tier.

| Tier | Key | Prompt provenance | Capabilities | Spawned by |
|---|---|---|---|---|
| session | (singleton) | constant | full session toolset; the only `yaar://session/*` principal | first invocation of `yaar://session/agents/session` |
| monitor | `monitorId` | constant + `HINT.md` injections | monitor toolset | monitor creation |
| app | `monitorId::appId` | install-time disk (`AGENTS.md` / `SKILL.md`) | `describe`/`query`/`command`/`relay` (+`direct_message`, +`controls`), the app principal | first window interaction |
| sub-agent | `monitorId::appId::subId` | **runtime, verbatim** | one channel to its own app's iframe under app-declared tool names — or nothing at all | the owning app, via `yaar://apps/self/agents` |

**Ephemeral agents** are the one node that predates the model: monitor-tier helpers spawned only
as a busy-monitor fallback (`createEphemeral()`, called solely from `monitor-task-processor.ts`),
reusing the monitor's own profile and keyed by nothing. In tree terms they are monitor-tier
sub-agents with a degenerate capability set ("same as owner"). They have a slot; folding them
into it is opportunistic cleanup, not a pending requirement.

## The four laws

Every node below the session tier satisfies all four. A feature that can't is a different
feature.

1. **Ownership follows the key.** Every agent has exactly one owner, one tier up, and its pool
   key extends the owner's. Addressing goes through the owner (`yaar://apps/self/agents/{id}`),
   and *naming is not owning*: the appId in the URI must equal the appId the calling context
   says the caller is (`handlers/apps/agents-resource.ts`). An app cannot reach another app's
   sub-agents even if it declares that URI in its permissions — the permission list says what
   you may ask for, the ownership check says whose they are. Two monitors running the same app
   hold two disjoint subtrees.

2. **Descent never adds capability.** A child's capability set is a subset of its owner's, and
   each step down strips more than it keeps. The app agent holds the app's principal and its
   full toolset; a sub-agent holds no principal and, at most, a named subset of the protocol
   commands its owner could already issue — often nothing. Cross-app grants (`controls`,
   `direct_message`) never descend: they are grants to the process's main thread, not to the
   process.

3. **Prompts descend toward runtime; capabilities stay at install time.** Going down the tree
   the system prompt becomes progressively more caller-supplied — session and monitor prompts
   are YAAR's constants, the app agent's comes off disk at install, a sub-agent's arrives
   verbatim at spawn. Capabilities move the *opposite* way: they are a fixed menu written once
   in `agents/profiles/`, **selected** at spawn, never composed there. This is why overriding a
   prompt at runtime is safe — the hands are not overridable. A runtime string chooses from a
   menu; it never writes the menu.

4. **Lifecycle cascades down.** Disposing an owner disposes its subtree: removing a monitor
   tears down its app agents and their sub-agents; an app's last window on a monitor closing
   tears down that app's sub-agents. No node outlives its owner and none survives the session.
   Durable identity is app data (`appDb`/`appStorage`), replayed into a fresh node's first turn.

`list('yaar://session/agents')` returns both views of this — `agents` flat and `tree` nested. A
`tree` node with `id: null` is a vacant owner slot: ownership follows the key, not the instance,
so an app's sub-agents hang under `monitorId::appId` whether or not that app ever grew an agent
of its own.

## Why a tree instead of more tiers

The codebase was on a trajectory of one new pool tier per capability need, each adding a map, a
verb surface, and a teardown hook — the third tier of plumbing being the second with different
nouns. Two alternatives were weighed and rejected:

- **Multiple app agents with prompt overrides.** Keying is identical either way, so the map is
  not the cost. The cost is that tool-lessness becomes a runtime flag on a shared type, checked
  at four sites (allowlist derivation, `AppTaskProcessor` routing, prompt assembly, restore
  filtering) instead of nailed shut in one profile. The tree keeps the distinction structural.
- **Arbitrary tool lists at spawn.** Maximal flexibility, and exactly the escalation surface
  law 3 exists to prevent: a runtime-supplied prompt that also picks its own tools is a
  confused-deputy factory. Rejected permanently, not deferred.

## Placing a new node

When a request arrives for a new kind of agent, answer these in order:

1. **Which tier owns it?** If no existing tier can own it, the request is for a new *owner*
   tier, which is a much larger change than it usually sounds like.
2. **Is its capability set a strict subset of that owner's?** If not, law 2 says stop — the
   thing being asked for is an escalation, and escalations belong to the owner tier, not to a
   new child.
3. **Can its capabilities be written once in `agents/profiles/` and merely selected at spawn?**
   If the caller needs to *compose* capabilities, law 3 says no.
4. **Does it die with its owner?** If it needs to outlive one, it is storage, not an agent.

**What deliberately does not exist at any tier:** YAAR verbs selected by a runtime caller;
`relay`, `direct_message`, `controls`, or `yaar://` access in a sub-agent's hands; and
sub-agents spawning sub-agents — the tree is four tiers deep, not N, because a node spawning its
own children is an escalation ladder with no owner semantics. An app-defined tool list is not an
exception to this: every entry is a name over one channel to the app's own iframe.

The tripwire question is whether any sub-agent will ever need *real* YAAR verbs rather than an
app handler standing in front of them. So far none has — everything asked for ("read my own
state", "operate my own window") is expressible as an app-defined tool with the iframe as
executor, at strictly smaller YAAR surface. If a case ever genuinely needs verbs in a
sub-agent's hands, that is a different animal: user permission prompt at first spawn, per-verb
subset of the app agent's toolset, and its own design doc. Do not build it for symmetry.

## Budgets

`MAX_AGENTS` (default 10) is one global semaphore over every node with a provider process. Each
tier also budgets its own children: the session caps monitors (`MAX_MONITORS`), and an app's
`personas.max` caps its sub-agents (itself clamped to `MAX_SUB_AGENTS_PER_APP`, 16).

Because sub-agents hold no YAAR tools they are materially lighter than an agent with hands, so
they currently compete for slots they don't really cost — a 4-character room spends 7 slots
against one pool. Splitting the global semaphore (`MAX_AGENTS` for principal-holding tiers, a
larger ceiling for sub-agent nodes) is the known fix and is unstarted.

## Key files

| Concern | File |
|---|---|
| The tree, keys, spawn/turn/dispose | `agents/agent-pool.ts` (`subAgents`, `subAgentKey`, `buildAgentTree`) |
| What a sub-agent can touch — the one place | `agents/profiles/sub-agent.ts` |
| The one channel back to the owning iframe | `mcp/sub-agent/` |
| Verb surface + ownership check | `handlers/apps/agents-resource.ts` |
| `persona:` command convention (hidden from the app agent) | `features/apps/persona-commands.ts` |
| `personas` / `subagents` manifest parsing | `features/apps/discovery.ts` |
| Reference consumers | `apps/personas` (tool-less), `apps/chitchats` (`skip`/`memorize`/`recall`) |

All paths are relative to `packages/server/src/` unless noted.
