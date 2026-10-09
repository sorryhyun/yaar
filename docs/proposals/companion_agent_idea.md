# Idea: an always-on Haiku companion that proposes delegation

Status: idea only, nothing built. Recorded 2026-10-09.

## Why

A pass over the `.claude/projects/-Users-kscnc-yaar-storage` transcripts (470 sessions of
monitor and app agents) found that context mostly grows through the agent doing bulk work itself:

- Session peak context: median 81k, 122 sessions over 150k, 34 over 300k, max 594k.
- The largest cumulative growth comes from ordinary reads repeated many times. devtools
  `readFile` was called 2014 times for +9.2M tokens in total, `editFile` +3.6M,
  `subagent__read_file` +3.0M, `grep` +2.6M, and `cloneApp` averaged 8.8k per call.
- Delegation already exists and goes unused. devtools has `workerTask`, a sonnet-tier explorer
  with read-only tools that reports back. Over the same sessions it was called 81 times, against
  2014 direct `readFile` calls. Having the tool is not enough; the agent has to be prompted to
  use it at the moment it starts a survey.

## The idea

Every agent (the monitor agent and each app agent) gets a Haiku companion that **always runs
alongside it**. The companion is not aimed at specific blow-up points. It follows the agent's
work in general and decides for itself when to step in.

- The companion sees the agent's stream: the task, the tool calls, and (some form of) their
  results.
- Its prompt says: **use your tool only when it is worth it.** Its ordinary text replies go
  nowhere, so a silent companion costs the agent nothing.
- It holds one tool, something like `propose`. A call to it is the only thing that reaches the
  real agent. The server delivers it as a message:
  "Shall I do <broad search / bulk task>? I'll use <these permissions>."
- The agent accepts or declines. On accept, the companion (or a worker it starts) does the work
  and returns the distilled result instead of the raw material.

The push comes from outside the agent, which is what `workerTask` lacks.

## Open questions

- **What the companion sees.** Does it get the full stream, or only tool calls plus result
  sizes and heads? Its own context grows with the agent's, so it needs a rolling window or its
  own compaction.
- **Delivery.** How does a proposal reach a busy agent? The monitor queue is sequential, so a
  queued message is a whole new turn. The options are injecting it mid-turn (the way
  `<app:event>` wakes an app agent) or attaching it to the next tool result.
- **Authority.** The companion must not be a principal of its own. It acts with a subset of the
  agent's own permissions (read-only for surveys). "I'll use <permission>" therefore states the
  scope rather than asking for a grant. Check this against the four laws in
  `docs/architecture/monitor_and_windows_guide.md`.
- **Acceptance protocol.** Is the answer a tool call on the agent's side, or a reply message?
  What happens to a proposal the agent ignores?
- **Cost.** Haiku tokens on every turn of every agent, with prompt caching. A silent companion
  must stay cheap. Measure its false-positive rate against the transcripts before rollout.
- **Model pinning.** `subordinateModel()` upgrades every non-monitor agent to Opus in
  `FABLE=1` mode, so the companion must pin Haiku explicitly. Under Codex, haiku maps to Luna.
- **Relation to existing pieces.** It overlaps with devtools `workerTask` (the worker could be
  the thing a proposal starts) and with the 100k result spill (`mcp/result-spill.ts`).

## Considered alternative (complementary, not this idea)

A server-side gate at the call itself. When a result's size is known or estimable before
execution (storage file size, a storage-wide grep with no glob, a recursive git tree, `exportSong`
with no path), the server would refuse and return the same proposal: narrow it, `delegate:
"<what you need>"` to a Haiku worker, or `force`. This catches the single huge results the
companion would only see after they landed. It does nothing for the slow accumulation, which is
where the companion helps.
