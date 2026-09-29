# Known Bugs

Each entry is from **reading the code**, not from a reproduction, unless it says otherwise. The
first step of fixing any of them is a test that fails. Paths are relative to
`packages/server/src/`. Remove an entry when its fix lands.

---

## Minor

### 1. Two instances on one checkout share sandbox browser session records

**Where:** `lib/browser/session-store.ts` (`storage/.browser/sessions.json`).

Scratch dirs and PID files are now keyed per server PID, so two YAARs no longer kill each other's
Chrome. They still read and write one `sessions.json` when they share a checkout, even with
`YAAR_BROWSER_EPHEMERAL=1`, so each can overwrite the other's session records. Separate
`YAAR_WORKSPACE`s avoid it.

### 2. Ctrl+C can briefly relaunch the sandbox Chrome

**Where:** `lib/browser/pool.ts` (`watchProcess`, `shutdown`).

A terminal Ctrl+C signals Chrome's process group too, so Chrome can exit before `shutdown()` sets
`stopped`. The exit watcher then reads it as a crash and relaunches once during the session
drain. `shutdown()` kills the new Chrome, so nothing is orphaned; it is one wasted launch.

### 3. Crash-relaunch and the per-instance PID file are untested on Windows

**Where:** `lib/browser/pool.ts` (`watchProcess`'s endpoint check), `lib/browser/pid-file.ts`.

The Windows path treats a process exit as a crash only when the DevTools endpoint has also
stopped answering, because the spawned process can be a launcher. Nothing has run it on Windows.
