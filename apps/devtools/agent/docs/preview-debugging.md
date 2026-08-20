---
name: preview-debugging
description: Read when the preview disagrees with the state, a probe 403s, or a screenshot warns — the debugging long tail.
audience: agent
---

## Preview & Debugging — beyond the core loop

**A `previewCommand` that passes a storage path can 403 where the same command from the
session principal succeeds.** You relay as an app-role principal, and an app may not hand its
own reach to another app (`mayDelegateGrants`) — so a file *you* can read is not delegated
through the relay. The refusal now says so ("cannot delegate grants"); read the text before
concluding a permission is missing, because the same call made by the session agent will
reach the file. This is a confinement rule, not a bug in the app under test — and it bites
hardest when you are checking whether a permission is still needed.

**Resource failures surface in `consoleLogs`** (`[resource] failed to load <img>: ...`) —
that is how you catch a broken asset, which produces no `console.log` and does not fail the
build.

**`previewEval` cannot see your app's module scope, and no expression makes it.** The bundle
is an ES module, so its top-level bindings — signals, `let`s, helper functions — are not on
`globalThis`; eval there reaches browser builtins and the injected YAAR runtime only. Module
state is observable through exactly two projections: `previewQuery` for whatever
`defineApp({ state })` declares, and the DOM for whatever gets rendered. If you need to
watch a value that is neither, add it to `state:` — that is what it is for — rather than
hunting for an eval expression that will never resolve it.

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
deployed app's**, which is what you want while iterating, but means a cross-app hand-off
(another app reading `shared/{appId}/`) is the one thing a preview cannot rehearse end to
end. Deploy, then check that.

**Its `permissions` and `bundles` are read off the sandbox `app.json` too**, so a declared
grant is in force in the preview — a write to a path under `yaar://storage/` really writes
there, which is the point of testing it here. Two limits: the preview can never reach past
**Dev Tools' own** permissions (the `uri-reference` topic — `yaar://config/` and
`yaar://history/` are out for both of us, and a project declaring one gets it dropped, not
honoured), and the list is read **when the preview window is created**, so edit `app.json`
first, then re-open the preview.

**The first headless-browser call after a cold start can come back empty** (`postCount: 0`
and the like); retry once before concluding the app itself is broken. Cache
expensive-to-build state (scraping, multi-step fetches) into `appStorage` keyed by source
URL + TTL, so a remount rehydrates instantly instead of re-running it.

**Confirm network-dependent probe results twice before reporting them as fact.** Scrape
counts and lazy-load outcomes vary run to run; one read is not evidence.

`compile` runs the manifest-drift check automatically whenever a preview is open, surfacing
`manifestDrift` in its result as a warning, never a build failure.
