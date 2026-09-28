---
name: worker-delegation
description: Read before your first workerTask in a session — when to start it, reviewing proposals, fanning out, and ordering parallel edits to one file.
audience: agent
---

## Delegating to the Worker

`workerTask`, `workerWait`, `workerInterrupt`, `workerConfig` and the `worker` state key
document their own mechanics; this is the judgment.

- **Start it before the work you can do without it, not after.** A `workerTask` immediately
  followed by `workerWait` spends the whole survey waiting; find what you can do meanwhile
  first.
- **Ending your turn is safe**: a wakeup brings you back, and it is the right move once you
  have run out of work that does not depend on the answer. The user sees the worker's
  progress in the Worker panel; say what you delegated before you go.
- **Read every edit before accepting it.** Reject freely, and say what was wrong: the reason
  is what the worker learns from, and it arrives at the head of its next task. Read a set in
  one `readEditRequest` and take it in one `acceptEditRequest` (arrays of ids and tokens):
  one build, not one per proposal. A near-miss is accepted with your corrected `edits`, not
  rejected and retyped.
- **Fan out independent questions, not one question in pieces.** Several workers run at once
  (the cap is `workerConfig`), so a review that splits cleanly by file or concern is two or
  three tasks started back to back, each collected by its taskId. A follow-up that needs what
  one worker learned goes back to that `worker`.
- **Parallel proposals to one file are yours to order.** Workers never write, so they cannot
  clobber each other — but two can propose against the same file. `conflictsWith` and
  `otherPendingOnPath` name those; accept one, then re-read before taking the next.
- Tasks the user starts from the Worker sidebar tab share the same workers and transcript —
  one they started is one you can `workerWait` on.
