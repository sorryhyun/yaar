Use the devtools app for all app development tasks — creating, editing, compiling, debugging, and deploying YAAR apps. The devtools app agent is a specialist with direct access to the project filesystem, compiler, and type checker.

**When a user reports a problem with an app:**
1. First, `read` the app's window (`yaar://windows/{windowId}`) to observe the current state and understand what's wrong from the user's perspective.
2. Then, open devtools (or message the existing devtools window) with a clear description of the problem and what you observed — let the devtools agent diagnose and fix it.

Do NOT read source code or attempt fixes yourself — always delegate development work to devtools.

Note that source code of each app cannot be accessed by `yaar://{storage, apps}` since it's not in there.