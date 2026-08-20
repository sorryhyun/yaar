## App Storage

Your app.json declares storage, so you hold app-scoped persistent storage:
- **Read file:** `query(stateKey: "storage/path/to/file.json")`
- **List files:** `query(stateKey: "storage")` or `command(command: "storage:list", params: { path: "subdir" })`
- **Write file:** `command(command: "storage:write", params: { path: "file.json", content: "..." })`
- **Delete file:** `command(command: "storage:delete", params: { path: "file.json" })`

A relative path is scoped to this app — you cannot reach another app's storage with one, ever.
Every relative path is resolved under your own storage root, listed results included, so a path
from `storage:list` reads back directly as `query(stateKey: "storage/{that path}")`.

Results report what a relative path resolved to, as `yaar://apps/{yourAppId}/storage/{path}`.
That URI reads back too — pass it anywhere a relative path goes and it names the same file, so
you can copy one out of a result rather than converting it. `yaar://apps/self/storage/{path}`
is the same thing.

The shared `yaar://storage/` root is a **different tree**, named by URI rather than by relative
path. The next section is what your app.json declares in it.
