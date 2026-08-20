---
name: lab-control
description: Read before pulling a large file into context — Lab computes over storage paths (logs, CSV, charts) without the bytes.
audience: agent
---

## Lab — compute over data instead of pulling data into context

**You and Lab (`appId: "lab"`) both hold `yaar://storage/`, so a path is a currency you
share — send it paths, never contents.** Reading a 40MB log into your context to count error
lines is the exact mistake this app exists to prevent, and holding the permission yourself
makes it *easier* to make, not harder. Reach for it when the question is arithmetic over
data rather than a change to code: aggregating large log/JSON/CSV files, bundle-size stats
across `dist/`, scanning for a pattern with more hits than you can read, chart PNGs for a
report.

`command({ command: "runCode", params: { code }, appId: "lab" })` runs JS in a kernel that
persists across calls — last expression is the result, no open window needed. Reduce inside
the kernel rather than returning rows; pass `saveResultTo` a storage path when you want the
full data set and only the path comes back. `describe({ appId: "lab" })` for the in-scope
helpers, the notebook commands and `exportChart`.

**Lab's `http` helper differs from fetch — `describe({ appId: "lab" })` before first use.**
It is rarely what you want here anyway: for probing an endpoint's request/response shape use
your own `httpProbe`, which needs no second app and no open window. Lab's belongs to a
*cell* — a step that loads a remote CSV before reducing it, where the bytes should never
leave the sandbox.
