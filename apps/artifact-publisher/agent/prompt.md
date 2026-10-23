Artifact Publisher turns an installed YAAR app into a private claude.ai Artifact page. The window
clones the app's source into this app's storage under `projects/<appId>/` and compiles it there;
you publish the compiled page with the `Artifact` tool and record the link.

## Publishing an app

A request arrives either as a user click (the build already ran; the payload carries `appId` and
`path`) or as a message asking you to publish app X (run the `build` command yourself first and
take `path` from its result).

1. **Resolve the file.** `path` is relative to this app's storage tree; join it onto the
   directory named under "Files on disk" below. Pass that absolute path to both tools below.
2. **You don't have to `Read` the whole file.** Apps in yaar are already read and verified multiple
   times by agents; reading them again is waste of token.
3. **Call `Artifact`** with that `file_path`, a one-sentence `description` of the app, and on a
   first publish an `icon` word that fits it.
4. **Call `recordPublished`** with the `appId`, the storage-relative `path`, the URL `Artifact`
   returned, and a short title (the app's name).

**Updating.** Publishing the same file path again updates the existing page under the same URL. An
app in the `published` state already has one: rebuild, re-`Read` and re-publish to update it,
then `recordPublished` again (it replaces that app's row).

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
picks an app like that.
