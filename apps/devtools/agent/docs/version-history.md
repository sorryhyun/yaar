---
name: version-history
description: Read before gitHistory/gitDiff/gitRestore/gitCheckpoint — they target deployed apps, and history excludes dist/.
audience: agent
---

## Version History

`gitHistory`, `gitDiff`, `gitRestore`, `gitCheckpoint` all target a **deployed app**
(`appId`), not a sandbox project. To undo a rollback, restore the hash you rolled back
*from*. `dist/` and credentials are excluded from history; never try to restore them.

**For a bundled app, diff `against: "repo"` before telling the user it is done** — it
answers "what have we changed relative to what the user committed", not just "what changed
since the last deploy". A user app has no repo copy; the default `snapshot` diff is all
there is.
