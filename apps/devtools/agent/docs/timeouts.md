---
name: timeouts
description: Read before passing timeoutMs or waitMs, when a call says it did not respond or answer, or before anything slower than 30s.
audience: both
---

## Timeouts

A slow call runs against two clocks, and both must be long enough.

- **Host wait**: how long the caller waits for the command to answer. On the `command` tool it
  is the top-level `timeoutMs`, beside `command`, never inside `params`. Default 30s, max 180s.
  It belongs to the call, so no command's signature lists it. Running out reads
  "App did not respond within Ns".
- **Inner wait**: how long the command waits on the preview. It is the `waitMs` param. Running
  out reads "Preview did not answer the eval within Ns" or a `stage: "run"` error from
  `test/run`.

| Command | Inner wait | Host wait to pass |
| --- | --- | --- |
| `preview/eval` | `waitMs`: default 5s, max 180s | above `waitMs` |
| `preview/command` | `waitMs`, per command: default 30s, max 180s | above `waitMs`; above their sum for a `batch` |
| `preview/query` sampling | `durationMs`, max 120s | above it, past ~25s |
| `preview/script` | `timeoutMs` on a step in the script file | past the sum of the steps; 40 steps want 120000+ |
| `test/run` | `waitMs`: default 60s, max 170s | ~120000: the build comes on top of the run |
| `worker/wait` | `waitMs`: default 60s, max 170s | `waitMs` + 10s |
| `worker/acceptEdit` | none | ~120000 when it builds |
| `build/compile` | none | ~60000 |
| `build/deploy` | none | ~120000 |

```
command({ command: "preview/eval", params: { expression, waitMs: 60000 }, timeoutMs: 65000 })
```

- **Both clocks have a 1s floor.** A smaller value waits 1s, so a call cannot be made to fail
  faster than that, and a timeout path shorter than 1s cannot be tested this way.
- **`timeoutMs` as a param** of `preview/eval`, `preview/command` and `test/run` is the older
  name for `waitMs`, and still works; `waitMs` wins when both are passed.
- **A direct verb call has one `timeoutMs`.** Invoking a command's URI without the `command`
  tool, the payload's `timeoutMs` is spent as the host wait, so only `waitMs` can set the inner
  one apart from it.
- **An open-ended wait** should not raise either clock. Have the expression stash its result on
  `window` and return at once, then read that global back in a later eval. A job the app runs
  itself is polled through a state key (the `long-running-commands` topic).
