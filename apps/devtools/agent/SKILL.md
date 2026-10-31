# Dev Tools

The IDE for YAAR apps: its agent creates, edits, compiles, debugs and deploys them, with direct access to the project sandbox, compiler and type checker.

## Handing over a new app

State the multi-party needs in the spec in plain words: "several agents or roles", "user actions should wake the agent", "several windows share state", "large fixed layout". Devtools maps each to a platform feature (sub-agents, `sendInteraction`, storage subscriptions, `defaultWidth`/`defaultHeight`); left implicit, they get rebuilt by hand. Opening several windows of one app does not give several agents — they share one app agent per monitor.

## Handing over a debug, review or doc-audit pass

Say each of these, or the agent has to guess:

- **The target**: the app id, and which project if one is already open for it.
- **The outcome**: find and report, fix, or fix and deploy. A pass that may deploy says so.
- **The evidence**: what you saw in the app's window, read before handing over, and how to reproduce it.
- **What is off limits**: other apps, a project to leave alone, windows the user is working in, storage that must not be touched.
- **The rule for keeping a finding**: for a review, that each finding is confirmed against source first, and that a wrong one is reported as skipped.
- **Doc rules**: for a doc pass, that the `doc-trimming` topic binds it; it forbids `git/restore`, `project/delete` and deploying.
- **The report**: the sections you want back. A deploy of Dev Tools itself can reload its window, so ask for the full report in the final message.

## What delegating here changes

- **The active project moves.** `project/cloneApp` and `project/create` take the front without asking, and every file and build command acts on the active project. `project/delete` on the clone returns to the one before. A second hand-off during a pass can land in the wrong project: name the project each time.
- **A deploy closes the user's open windows of that app**, and their in-app state goes with them. A deploy of Dev Tools leaves its own window on the old bundle until it reloads. Ask for the closing to be announced first if the user is working there.
- **A preview is not fully isolated.** Only `self` paths stay in preview storage; an app or a regression script writing a literal `shared/{appId}/` path writes the real file. `preview/script` reports `realStorageWrites` after the fact. Ask for `build/check`'s `previewEscapes` first when real files matter.
- **A bundled app can drift from its repo.** A deploy changes the installed copy only; `git/diff` with `against: "repo"` shows the difference.

## Reading an app's source

| Need | Use |
| --- | --- |
| A file or a pattern in one installed app, leaving no trace | `project/readAppSource` |
| To change an app and deploy it | `project/cloneApp`; `project/diffInstalled` shows the changes so far |
| A question across many apps | the `search` app's `clone-app`, which writes copies to shared storage (`purge-clones` removes them) |
| The whole tree as data, in your own code | `invoke('yaar://apps/{id}', { action: 'clone' })`, the verb behind the first two; it returns every file in one reply |

A project's files are readable at `yaar://storage/apps/devtools/projects/{id}/`, and `files/read` names that URI in its results. Treat that path as read-only: a write there bypasses the Changes history and leaves the compile state claiming a check of bytes that are gone.
