---
name: worker-delegation
description: Read before your first worker/task in a session — when to start it, reviewing proposals, fanning out, and ordering parallel edits to one file.
audience: agent
---

## Delegating to the Worker

`worker/task`, `worker/wait`, `worker/interrupt`, `worker/config` (sets the cap) and the `worker`
state key (reads it, with each worker's status) document their own contract; this is the
judgment, then the mechanics they leave out.

- **Start it before the work you can do without it, not after.** A `worker/task` immediately
  followed by `worker/wait` spends the whole survey waiting; find what you can do meanwhile
  first.
- **Ending your turn is safe**: a wakeup brings you back, and it is the right move once you
  have run out of work that does not depend on the answer. The user sees the worker's
  progress in the Worker panel; say what you delegated before you go.
- **Read every edit before accepting it.** Reject freely, and say what was wrong: the reason
  is what the worker learns from, and it arrives at the head of its next task. Read a set in
  one `worker/readEdit` and take it in one `worker/acceptEdit` (arrays of ids and tokens):
  one build, not one per proposal. A near-miss is accepted with your corrected `edits`, not
  rejected and retyped.
- **Fan out independent questions, not one question in pieces.** Several workers run at once
  (the cap is `worker.maxWorkers`, set with `worker/config`), so a review that splits cleanly by file or concern is two or
  three tasks started back to back, each collected by its taskId. A follow-up that needs what
  one worker learned goes back to that `worker`.
- **Parallel proposals to one file are yours to order.** Workers never write, so they cannot
  clobber each other — but two can propose against the same file. `conflictsWith` and
  `otherPendingOnPath` name those; accept one, then re-read before taking the next.
- Tasks the user starts from the Worker sidebar tab share the same workers and transcript —
  one they started is one you can `worker/wait` on.

### Mechanics the commands leave out

- **Result vs report.** The result arrives as an `<app:event channel="worker">` of kind
  `"result"`. An urgent interim finding wakes you early as kind `"report"` — a cue to re-scope
  or `worker/interrupt`, not a sign the task is done.
- **Cut fields.** The wakeup is a prompt injection with a context budget, so a very long answer
  can arrive with fields ending `…[cut, N chars]` and a note naming them. `worker/wait` with the
  taskId returns the record whole.
- **Memory.** A worker keeps its memory across tasks, and a task goes to the worker that
  finished last when it is free. Pass `worker` to pin a follow-up to one, `fresh` to start it
  with no memory.
- **Scope.** The files a task names are its scope; the result reports `filesRead` and
  `filesNotRead` against it, and a turn that went quiet carries a `stopDiagnosis`. One worker
  turn over ~150 KB tends to go quiet, which is why such a task is refused unless split.
