---
name: preview-debugging
description: Read when the preview disagrees with the state, a probe 403s, a screenshot warns, a preview writes storage, or mouselook will not engage.
audience: agent
---

## Preview & Debugging

Where to start on an unlocated bug is the `debugging` topic; this one is how a preview differs
from a deployed app.

### What a preview can reach

**The preview runs under its own principal** (`preview--{projectId}`), so `self`-scoped calls
resolve against it and can be tested before deploying. It is isolated exactly as far as a path
says `self`:

| What the app calls | Where it lands | Isolated |
| --- | --- | --- |
| `appStorage`, `appDb`, `yaar://apps/self/...` | `apps/preview--{projectId}/` | yes |
| `sharedStorage`, `shared/self/...` | `shared/preview--{projectId}/` | yes |
| a literal `shared/{name}/...`, `yaar://storage/shared/...` | the real commons, which every app holds | **no** |
| `yaar://storage/...` under a declared grant | the real tree | **no** |

`test/run` runs under the same principal, so the same table applies to tests. Before a preview
writes, `build/check` lists literal paths as `previewEscapes`; after a `preview/script` run,
`realStorageWrites` lists the real files it changed in the directories those paths name and in
`shared/{appId}`. A path built at runtime is not seen by either.

The isolated trees are reclaimed when the project is deleted, and any left behind by a project
that is already gone are swept the next time `preview/open` runs.

**A file published under a preview sits in a different directory than the deployed app's**, so a
cross-app hand-off (another app reading `shared/{appId}/`) cannot be rehearsed in a preview.
Deploy, then check that.

**The preview has no app agent.** You are the agent inside it.

**Its `permissions` and `bundles` are read off the sandbox `app.json`**, so a declared grant is in
force in the preview. Two limits: the preview can never reach past **Dev Tools' own** permissions
(the installed manifest's, as `describe` reports them; a project declaring one it lacks gets it
dropped, not honoured), and the list is read **when the preview window is created**, so edit
`app.json` first, then re-open the preview. Install-time grants such as `subagents` are not in
force either: a command that spawns sub-agents fails in preview while the surrounding UI works,
so test pure logic there and the spawning path on the deployed app.

### Reaching module scope

**`preview/eval` sees your app's module scope only through `__debug`.** The bundle is an ES
module, so its top-level bindings (signals, `let`s, helper functions) are not on `globalThis`.
Declare what you need to reach in `defineApp({ debug: () => ({ engine, buildVoice }) })` and an
eval reads it as `__debug.engine`. The function form is re-read on every access, so a reference
the app later swaps is never stale. It exists only where eval is allowed (a preview); a deployed
window never exposes it and the manifest never lists it, so it can stay in the source. Prefer it
to re-implementing a code path inside an eval to measure it, or to planting a
`globalThis.x = ...` you must remember to remove. For a value an agent *driving* the app should
see, `state:` is still the place.

### Testing failure paths

**Break the call with `preview/faults`, not by patching `window.fetch` from `preview/eval`.** An
eval-installed wrapper dies on the next reload, so it never reaches the calls the app makes while
booting, the "first load fails" case. `preview/open` and `build/compile` say `FAULTS ACTIVE` while
any rule is set: clear them (`rules: []`) before you trust a failure you see. What rules catch and
how they persist is in the command's own description.

### When a probe surprises you

**A `preview/command` that passes a storage path can 403 where the same command from the
session principal succeeds.** You relay as an app-role principal, and an app may not hand its
own reach to another app (`mayDelegateGrants`), so a file *you* can read is not delegated
through the relay. The refusal says so ("cannot delegate grants"); read the text before
concluding a permission is missing, because the same call made by the session agent will
reach the file. Mind it when checking whether a permission is still needed.

**Resource failures surface in `preview/console`** (`[resource] failed to load <img>: ...`): that
is how you catch a broken asset, which produces no `console.log` and does not fail the build.

**Confirm network-dependent probe results twice before reporting them as fact.** Scrape counts
and lazy-load outcomes vary run to run, and the first headless-browser call after a cold start
can come back empty; one read is not evidence.

**A screenshot clones the DOM, and the clone loses inner scroll positions.** Scroll a container
to an element, capture, and the picture shows the container's top. Assert on the scrolled region
with `preview/query`/`preview/eval`, or keep the fixture short enough not to scroll.

**A black canvas in a screenshot is usually the GPU backbuffer, not a render bug**: the
`realtime-apps` topic has the capture-command fix.

**Pointer lock never engages under a click you synthesized.** The sandbox grants it
(`allow-pointer-lock`, previews included), but `requestPointerLock()` needs transient user
activation and a dispatched click is not one: the promise rejects and `pointerlockerror` fires.
An app that mouselooks therefore needs a non-locked fallback (drag to look, and a fire button that
is not the mouse, since the same button now steers), and a preview sitting in that fallback is
expected. Put which mode it is in `state:`, or the only evidence is HUD text. In a deployed window,
where a human's click *does* take the lock, the shell withholds Ctrl+W while it is held; that only
holds in a Chrome opened with `--app`.
