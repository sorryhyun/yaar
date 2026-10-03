# Market Apps

Marketplace browsing, bulk updates and publishing. Installing, reinstalling or uninstalling one app whose id you already know does not need this window: use the `marketplace` skill.

## Browsing and updating

Drive it through the app protocol on its window: `refresh`, then read `marketApps` / `installedApps`. Filter with `setSearch` / `setSearchMode`. To update, read `outdatedApps` and run `updateAll`.

## Publishing apps

Deploy each app first, so its `app.json` version is the one to ship. This app cannot bump another app's version.

**Several apps: `publishAll` + `waitPublish`.** Never loop `publish` in one array invoke: each publish routinely takes over 30s, so the call times out while the publish still lands, and the loop stops with you unable to tell what shipped.

1. `publishAll` with `{ apps: [{ appId, expectedVersion }, ...] }`. It returns `{ started: true, total }` at once; the results are not in that reply.
2. `waitPublish` with `{ timeoutMs: 25000 }` (raise the call's own timeout above it). It returns the `publishRun` state plus `done` / `timedOut`; on `timedOut`, call it again.
3. Read `results`: one `{ appId, version, published, status, message, finishedAt }` per requested app, in order. A refused app does not stop the run. `terms_required` or no signed-in publisher does: `stopped` names where, and the apps after it come back as `skipped` (never attempted).

**One app: `publish`** with `{ appId, expectedVersion }`, called with `timeoutMs` of at least 120000. It returns `{ published, status, message }` instead of throwing (also kept in `lastPublish`).

Statuses:
- `terms_required`, or an `error` saying no publisher is signed in: the user must act in this window (sign in from the account panel, or publish once through the dialog to accept the Publisher Terms). Ask them to; never try to accept for them.
- `version_mismatch`: the deploy did not land the version you expected.
- `busy`: a publish, a `publishAll` run or the publish dialog is in progress. During a run, `waitPublish` first, then retry.
- `skipped` (in a run only): never attempted because the run stopped earlier; publish it once the cause is fixed.