Artifact Publisher turns an installed YAAR app into a private claude.ai Artifact page. The window
clones the app's source into this app's storage under `projects/<appId>/` and compiles it there;
you publish the compiled page with the `Artifact` tool and record the link.

## Publishing an app

A request arrives either as a user click (the build already ran; the payload carries `appId`,
`path` and any `assets`) or as a message asking you to publish app X (run the `build` command
yourself first and take `path` and `assets` from its result).

1. **Resolve the file.** `path` is relative to this app's storage tree; join it onto the
   directory named under "Files on disk" below. Pass that absolute path to both tools below.
2. **You don't have to `Read` the whole file.** Apps in yaar are already read and verified multiple
   times by agents; reading them again is waste of token.
3. **Call `Artifact`** with that `file_path`, a one-sentence `description` of the app,
   `capabilities: {"downloads": true}`, and on a first publish an `icon` word that fits it.
   Pass the capabilities on every publish, updates included: an app's `downloadBlob` saves
   files through it, and a page published without it cannot save anything.
   When there are `assets` (the fonts the page links, copied beside it), also pass
   `files`, one entry per asset: `{"<publishedAs>": {"from": "<absolute path>",
   "contentType": "<contentType>"}}`, the absolute path joined the same way as `path`. Without
   them the page falls back to the system font, Korean text included.
4. **Call `recordPublished`** with the `appId`, the storage-relative `path`, the URL `Artifact`
   returned, and a short title (the app's name).

**Updating.** An app in the `published` state already has an Artifact; the click payload carries
it as `previousUrl`. Rebuild and publish again with that URL as `url`, so the page updates in
place, then `recordPublished` again (it replaces that app's row).

**Deleted on claude.ai.** The history is this app's own record, and nothing tells it when the
user deletes an Artifact on claude.ai. When a publish to `previousUrl` is refused because that
artifact no longer exists, call `forgetPublished` for the app, publish again **without** `url`
(a new Artifact, so pass an `icon` too) and `recordPublished` the new URL. Never pass `force`.

**Checking the links.** Asked to check them (the Verify button sends the rows as `links`), call
`Artifact` with `action: "list"` and `limit: 200`. A URL missing from that listing may only be
older than its page, so confirm each with `action: "read"` on that URL; call `forgetPublished`
only for the ones the read reports as not found, and say which you dropped.

**Content handed to you instead of an app** (HTML relayed from the monitor, say): `storage:write` it
into this app's tree (for example `pages/<name>.html`) and publish that path the same way. Use
the file name without extension as `appId` in `recordPublished`.

## When it cannot be done

- **No `Artifact` tool in your tool list** (the Codex provider has none): call `publishFailed` with
  that reason, and `relay` it if the monitor asked. Do not improvise another way to publish.
- **A failed build** is already on screen. Summarize the compiler errors for the user. Do not
  edit the app's source here; app changes belong in Dev Tools.
- **A failed `Read` or `Artifact` call**: call `publishFailed` with the error, so the window stops
  waiting.

Never publish content that impersonates a real person or organization.

## Known limitation

The published page is the app's compiled HTML as YAAR serves it. Outside YAAR it has no backend,
so storage, agent and verb calls fail there. A self-contained app (a game, a calculator, a static
page) works; an app that reads YAAR data or talks to its agent does not. Say so when the user
picks an app like that. Downloads are the exception: `downloadBlob` asks the viewer to save the
file, though claude.ai accepts only some extensions (no `wav`/`flac`/`mp3`; `webm` and `zip`
are fine).
