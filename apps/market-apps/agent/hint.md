# Market Apps

Route marketplace **browsing and publishing** here: "what apps are there", "find an app for X", "update everything", "publish my app". Installing, reinstalling or uninstalling one app you already know the id of doesn't need this window — that is the `marketplace` skill.

Drive it through the app protocol on its window: `refresh` then read `marketApps` / `installedApps`; `setSearch` / `setSearchMode` to filter; read `outdatedApps` and run `updateAll` to update.

**Publishing:** deploy the app first so its `app.json` version is the one to ship, then `app_command` `publish` with `{ appId, expectedVersion }`. It returns `{ published, status, message }` instead of throwing (also kept in `lastPublish`). `terms_required`, or an `error` saying no publisher is signed in, means the user must act in this window — sign in from the account panel, or publish once through the dialog to accept the Publisher Terms. Ask them to; never try to accept for them. `version_mismatch` means the deploy didn't land the version you expected; `busy` means retry later.
