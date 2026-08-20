## Storage & Files

```
invoke('yaar://storage/docs/readme.txt', { action: "write", content: "Hello" })
invoke('yaar://storage/docs/readme.txt', { action: "edit", old_string: "Hello", new_string: "Hi" })
invoke('yaar://storage/', { action: "grep", pattern: "TODO", glob: "*.md" })
read('yaar://storage/docs/readme.txt')
list('yaar://storage/docs')
delete('yaar://storage/docs/readme.txt')
```

**Reserved prefixes.** The flat tree has five by convention:

| Prefix | What lives there |
|---|---|
| `shared/{producer}/` | Artifacts apps publish for **each other** — a generated image, an exported deck, a computed dataset. Every app can read and write it **without declaring anything**, so a file here keeps working after the window that introduced it closes. |
| `temp/` | Scratch, including OS file drops. Safe to prune. |
| `files/` | The user's own documents. |
| `apps/{id}/` | One app's **private** storage — the same files as `yaar://apps/{id}/storage/`. You can read it; the app itself cannot read any other app's. |
| `mounts/{alias}/` | Host directories the user mounted, addressable like any other path. Present only when a mount exists, and then `list('yaar://storage/')` shows it; `read('yaar://config/mounts')` gives each alias's real host path and whether it is read-only. |

**Moving a file — use `copy`, never read-then-write.**

```
invoke('yaar://storage/shared/anima/dragon.png', { action: "copy", from: "yaar://apps/anima/storage/generated/2026-07-19T10-02-seed42.png" })
```

`copy` moves the bytes server-side and works in either direction between the two
spellings. Reading an image and writing it back drags several hundred KB of base64
through this conversation for no gain.

**PDFs.** To *show* a PDF, open it in a window — the browser renders it natively, don't read it:
`invoke('yaar://windows/<id>', { action: "create", renderer: "iframe", content: "yaar://storage/<path>.pdf" })`.
`read` on a `.pdf` returns metadata only. To read the content yourself: `pdfText: true`
extracts the text layer (cheap, all pages — use this for text-based PDFs); `pdfPages: "1-3"`
rasterizes pages to images (for scanned/visual PDFs).

**Binary.** Pass `encoding: "base64"` when writing image or PDF bytes. Without it the
base64 *text* is what lands on disk — a file that looks written and is unreadable.

**Handing a file to an app.** Name the `yaar://storage/…` URI in the `app_command`
params — or in the create payload, or as a launch parameter on the app's own URI
(`yaar://apps/{id}?file=yaar://storage/…`) — and the app may read *that file*, in *that
window*, for as long as the window is open. You are lending it your own reach; there is
nothing to declare and nothing to copy first.

```
invoke('yaar://windows/<id>', { action: "app_command", command: "open",
                               params: { path: "yaar://storage/files/report.md" } })
```

The lend is narrow on purpose: that one file, `read` only, dropped when the window
closes. An app that must *write* the file, or reach a whole folder, needs that in its own
app.json `permissions`. To hand a file to an app **for keeps** — across windows and
sessions — `copy` it into `shared/{producer}/` and `direct_message` the app naming the new
URI; every app reaches `shared/` with no permission to declare and none to grant.
