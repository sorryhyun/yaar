## App Storage

Every app holds its own persistent storage, and you reach it directly — no permission, no
declaration, and no need for a `protocol.json` command to write it on your behalf. `app/` is
what names that tree:
- **Read file:** `query(stateKey: "storage/app/path/to/file.json")` or `command(command: "storage:read", params: { path: "app/file.json" })`
- **List files:** `query(stateKey: "storage/app")` or `command(command: "storage:list", params: { path: "app/subdir" })`
- **Write file:** `command(command: "storage:write", params: { path: "app/file.json", content: "..." })`
- **Delete file:** `command(command: "storage:delete", params: { path: "app/file.json" })`

`app/` is a spelling, not a folder of yours: `app/notes.json` is the file `notes.json` at your
own storage root. Exactly two leading segments work this way — `app/{path}` is your tree and
`shared/{path}` is the **commons** (`yaar://storage/shared/{path}` — see the next section; no
permission needed) — so no path you write can be read as the wrong tree, and you cannot create
a private folder named `app` or `shared` here.

A path with neither prefix is still yours: `storage:read` on `file.json` reads the same file as
`app/file.json`. Every result *prints* the `app/` form, so a path from `storage:list` reads back
directly as `command(command: "storage:read", params: { path: "{that path}" })` — or as
`query(stateKey: "storage/{that path}")`.

You cannot reach another app's storage with either spelling, ever.

Results also report what a path resolved to, as `yaar://apps/{yourAppId}/storage/{path}`. That
URI reads back too — pass it anywhere a path goes and it names the same file, so you can copy
one out of a result rather than converting it. `yaar://apps/self/storage/{path}` is the same
thing.

This is your app's own tree, so it is yours to write. Your app's iframe writes the same tree
through `@bundled/yaar`, which means state you change here is state the UI reads — prefer a
`protocol.json` command when the app has one for the job, since it keeps the app's own
invariants; reach for these calls when it does not.

**An app may override these.** If `describe` lists a command named `storage:read`,
`storage:write`, `storage:delete` or `storage:list` — or one whose aliases include that name —
then that spelling runs the app's own command instead of the raw file operation, with the
params you passed, and the answer is the app's (it opens with a note saying so). Read the
command's description before calling: an override can take different params and mean something
richer than bytes-in, bytes-out (a document editor's `storage:write` saves the *document* to
the path, in the format its extension names). An override takes every path that costs no
permission — your own tree (`app/…`) and the commons (`shared/…` / `yaar://storage/shared/…`);
any other `yaar://storage/…` path always runs the built-in below.

The shared `yaar://storage/` root is a **different tree**, named by URI rather than by relative
path. The next section is what you hold in it.
