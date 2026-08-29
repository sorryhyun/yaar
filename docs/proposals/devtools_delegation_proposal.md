# Proposal: fix devtools delegation — the worker offloads the cheap half

**Status:** proposal
**Date:** 2026-08-20
**Sibling proposals:** the app-agent docs proposal, the devtools authoring-guide proposal, and
the instruction-channel audit — none of which were checked in; this is the only survivor.

## Problem

Devtools was granted `"subagents": { "max": 2 }` and grew a worker, but the bottleneck it
was meant to relieve — the main opus agent's serialized turn stream — is unchanged. The
worker pattern as implemented delegates the *cheap* half of the job and keeps every
expensive, serialized operation on the main agent.

## Diagnosis (from code)

1. **The worker is read-only exploration, nothing else.** Its four tools —
   `list_files`, `read_file`, `grep`, `report` (`apps/devtools/src/services/worker.ts:442-494`,
   handlers in `src/protocol/index.ts:140-229`) — cannot edit, compile, or deploy. Its own
   prompt says so: "Your tools are read-only... describe the precise edit you would make so
   the caller can apply it."
2. **Every dominant cost stays on the main agent.** All mutations (`writeFile`/`editFile`),
   `compile` (~60s timeout), `deploy` (~120s), typecheck, git ops, cross-app control, and
   even *managing the worker* (`workerWait`, `workerInterrupt`) are main-agent commands.
   Delegating reads does not touch the cost centers.
3. **The delegation is net-negative on tokens for small tasks.** `agent/prompt.md` itself
   requires "its report is its word, not yours: verify before editing on it" — so the main
   agent re-reads what the worker read. The saving is real only for wide surveys; for
   anything narrow, the spawn + report + verify round trip costs more than reading inline.
   (This is Claude Code's delegation-restraint rule learned the hard way: "Do not spawn a
   subagent to verify work you can verify inline.")
4. **One worker task in flight, by refusal.** `startWorkerTask` refuses a second task while
   one runs (`worker.ts:572-579`) — "refused, not queued." The granted second slot is
   structurally unused: one fixed persona (`WORKER_ID = 'worker'`), forever.
5. **The worker's answer queues behind everything else.** A wake re-enters
   `AppTaskProcessor.handleAppTask` and competes for the same single `(monitor, app)`
   processing slot as every other task (`app-task-processor.ts:94-304`,
   `window-event-coordinator.ts:131-147`). If the main agent is mid-turn, the finished
   report sits steered-or-queued like a user message.
6. **A model-mapping bug specific to this path.** `SubAgentRegistry.runTurn`
   (`sub-agent-registry.ts:283-304`) passes the app's literal `model: 'sonnet'` straight to
   the provider, bypassing `turnOptionsFor`/`claudeModelToCodex` (`profiles/index.ts:80-83`)
   — under Codex the untranslated Claude alias goes into `thread/start`. (`claudeModelToCodex`
   also lacks a `haiku` branch entirely, `model-tiers.ts:28-33`.)

The one-line diagnosis: **the pattern delegates understanding and keeps execution, and the
economics run the other way.** Exploration is where the main agent's judgment pays for
itself (it must verify anyway); edit-compile-fix loops are mechanical, long, and perfectly
delegable — and they are exactly what the worker cannot touch.

## Redesign

In order of leverage. Items 1–3 are app-side only (persona tools route through the iframe,
so the containment law — sub-agents reach nothing but their app — is untouched). Item 5 is
a server fix.

### 1. Background compile/deploy with completion wake (no subagent involved)

The single biggest serialization is not exploration — it is the main agent sitting inside a
60–120s `command('compile'|'deploy')` call. Add `compileStart`/`deployStart` commands that
return immediately with a job id, run in the app, and reuse the existing worker-wake
mechanism (`app.emit(..., { wakeAgent })`) on completion. The main agent edits the next file
while the compiler runs — the parallelism the worker was supposed to provide, without an
agent at all. `compileStatus` is already three-valued and load-bearing (devtools AGENTS.md),
so the state surface for "in flight" exists.

### 2. Invert the delegation: add a scribe persona

Second persona in the unused slot: **scribe** — `persona:apply_edits` (a batch of precise
edits: file, anchor, replacement), `persona:compile`, `persona:read_file`, `persona:report`.
The main agent does what Claude Code's guidance calls "prompts that prove you understood":
it specifies the exact changes, and the scribe runs the edit → compile → fix-the-typo loop,
reporting a diff summary + compile status. Understanding stays with opus; the mechanical
loop moves to sonnet. This is the delegation direction the current design inverts:

| | today | proposed |
|---|---|---|
| explore/understand | worker (then re-verified by main) | main agent (it verifies anyway) or surveyor, for wide sweeps only |
| edit-compile-fix loop | main agent, serialized | scribe |
| compile/deploy wait | main agent, blocking | background job + wake |

The surveyor (today's worker) stays for genuinely wide sweeps — its prompt gains the
delegation-restraint rule: *narrow questions are cheaper inline; use the worker when the
survey would take many command turns, not to avoid reading one file.*

### 3. Worker output contract

Both personas' prompts adopt the return-value framing that makes reports synthesizable:
"Your final text is your report to the calling agent, not a message to a human — lead with
the answer, then evidence paths. No preamble, no confirmations." Plus the density contrast
pair (good: "3 call sites for openUrl: a.ts:12, b.ts:40, c.ts:88; only c handles
{handled:false}" / bad: "I searched the files you mentioned and found some call sites").

### 4. Report delivery that doesn't queue behind unrelated turns

Small server-side option, worth doing after 1–2 land: let a sub-agent report attach as a
**context note** on the app agent's next turn (the mechanism window-change subscriptions
already use) instead of always being a queued wake task. Wake-when-idle, annotate-when-busy.
This removes cause 5 without touching the single-flight invariant.

### 5. Fix the model-tier path (bug fix, independent of the rest)

Route sub-agent spawn models through `resolveAgentModel` and turn options through
`turnOptionsFor` so Codex deployments get translated ids; add the missing `haiku` branch to
`claudeModelToCodex`. This is a correctness fix that should land regardless of the redesign.

## What stays

- **The containment law.** Every new persona tool is `persona:*` through the app's own
  iframe; sub-agents still hold no verbs, no permissions, no principal.
- **Single-flight per persona.** Refusing concurrent tasks *per persona* is correct — two
  agents editing one project concurrently is a merge conflict generator. Parallelism comes
  from personas with disjoint capabilities (survey ∥ scribe ∥ background compile), not from
  queueing.
- **The persistent worker session.** Context accumulating across tasks in a session is the
  cheap kind of memory; `fresh: true` stays the escape hatch.

## Success criteria

A devtools session performing "change X across the app, verify, deploy" should show the
main agent's wall-clock dominated by *decisions* (which edits, whether the diff is right),
with compile waits overlapped and mechanical fix loops off its turn stream. Measurable in
session logs: main-agent turn count and total turn duration for a fixed benchmark task
(`scripts/bench/` has the harness pattern) before and after.
