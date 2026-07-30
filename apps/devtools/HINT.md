Use the devtools app for all app development tasks — creating, editing, compiling, debugging, and deploying YAAR apps. The devtools agent is a specialist with direct access to the project sandbox, compiler and type checker.

**When a user reports a problem with an app:**
1. First `read` the app's window (`yaar://windows/{windowId}`) to observe the current state and understand the problem from the user's perspective.
2. Then open devtools (or message the existing devtools window) with a clear description of the problem and what you observed — let the devtools agent diagnose and fix it.

Do NOT attempt fixes yourself — always delegate development work to devtools. App source is not reachable via `yaar://storage/` or `yaar://apps/`; it has to be cloned first, by devtools (as an editable project) or by the `search` app's `clone-app` (into storage, read-only, and it accepts a glob).
