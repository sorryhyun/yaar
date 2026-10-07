---
name: preview-debugging
description: Read when the preview disagrees with the state, a probe 403s, a screenshot warns, or mouselook will not engage — the debugging long tail.
audience: agent
---

## Preview & Debugging

**A `previewCommand` that passes a storage path can 403 where the same command from the
session principal succeeds.** You relay as an app-role principal, and an app may not hand its
own reach to another app (`mayDelegateGrants`) — so a file *you* can read is not delegated
through the relay. The refusal says so ("cannot delegate grants"); read the text before
concluding a permission is missing, because the same call made by the session agent will
reach the file. It is a confinement rule, not a bug in the app under test; mind it when
checking whether a permission is still needed.

**Resource failures surface in `previewConsole`** (`[resource] failed to load <img>: ...`) —
that is how you catch a broken asset, which produces no `console.log` and does not fail the
build.

**`previewEval` sees your app's module scope only through `__debug`.** The bundle is an ES
module, so its top-level bindings — signals, `let`s, helper functions — are not on
`globalThis`. Declare what you need to reach in `defineApp({ debug: () => ({ engine, buildVoice }) })`
and an eval reads it as `__debug.engine`. The function form is re-read on every access, so a
reference the app later swaps is never stale. It exists only where eval is allowed (a preview);
a deployed window never exposes it and the manifest never lists it, so it can stay in the
source — prefer that to re-implementing a code path inside an eval to measure it, or to planting
a `globalThis.x = ...` you must remember to remove. For a value an agent *driving* the app
should see, `state:` is still the place.

**Pointer lock never engages under a click you synthesized.** The sandbox grants it
(`allow-pointer-lock`, previews included), but `requestPointerLock()` needs transient user
activation and a dispatched click is not one — the promise rejects and `pointerlockerror`
fires. An app that mouselooks therefore needs a non-locked fallback (drag to look, and a fire
button that is not the mouse, since the same button now steers), and a preview sitting in that
fallback is expected. Put which mode it is in `state:`, or the only evidence is HUD text. In a
deployed window, where a human's click *does* take the lock, the shell withholds Ctrl+W while
it is held; that only holds in a Chrome opened with `--app`.

**To test a failure path, break the call with `previewFaults`, not by patching `window.fetch`
from `previewEval`.** An eval-installed wrapper dies on the next reload, so it never reaches the
calls the app makes while booting, the "first load fails" case. `previewFaults` rules are
enforced by the server, match verb calls by their `yaar://` URI, and survive reloads and
compiles. That last part cuts both ways: `preview` and `compile` say `FAULTS ACTIVE` while any
are set. Clear them (`rules: []`) before you trust a failure you see. Read the rules back after
the run: a rule with 0 hits means the app never made the call you meant to break.

When a `previewEval` has to wait a long or open-ended time, don't raise the timeouts
indefinitely — have the expression stash its result on `window` and return immediately, then
read that global back in a later, instant eval.

**The preview runs under its own principal** (`preview--{projectId}`), so `self`-scoped
calls resolve against it and can be tested here before deploying. That covers **both**
trees: `appStorage`/`appDb` (`apps/preview--{projectId}/`) and `sharedStorage`, which sends
`shared/self/…` for the server to expand — so a preview publishes to
`shared/preview--{projectId}/`, not into the shipped app's commons directory. Reclaimed when
the project is deleted, and any left behind by a project that is already gone are swept the
next time `preview` runs. The preview has **no app agent** — you are the agent inside it.

**A file an app publishes under a preview is therefore in a different directory than the
deployed app's**, so a cross-app hand-off (another app reading `shared/{appId}/`) cannot be
rehearsed in a preview. Deploy, then check that.

**Its `permissions` and `bundles` are read off the sandbox `app.json` too**, so a declared
grant is in force in the preview — a write to a path under `yaar://storage/` really writes
there. Two limits: the preview can never reach past
**Dev Tools' own** permissions (the `permissions` state key; a project declaring one it lacks
gets it dropped, not honoured), and the list is read **when the preview window is created**, so edit `app.json`
first, then re-open the preview. Install-time grants such as `subagents` are not in force
either: a command that spawns sub-agents fails in preview while the surrounding UI works,
so test pure logic there and the spawning path on the deployed app.

**Confirm network-dependent probe results twice before reporting them as fact.** Scrape
counts and lazy-load outcomes vary run to run, and the first headless-browser call after a
cold start can come back empty; one read is not evidence.

`compile` runs the manifest-drift check automatically whenever a preview is open, surfacing
`manifestDrift` in its result as a warning, never a build failure.

**A screenshot clones the DOM, and the clone loses inner scroll positions.** Scroll a
container to an element, capture, and the picture shows the container's top. Assert on
the scrolled region with `previewQuery`/`previewEval`, or keep the fixture short enough
not to scroll.

**A black canvas in a screenshot is usually the GPU backbuffer, not a render bug** — the
`realtime-apps` topic has the capture-command fix.
