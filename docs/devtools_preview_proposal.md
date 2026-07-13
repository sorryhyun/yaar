# Proposal: preview screenshots, preview identity, and window-key uniqueness

Three items from the DevTools friction report that are too large to land as drive-by fixes. The
cheap items from that report (preview window id, `writeFile` coercion, `consoleLogs` connection
state, the protocol log, and the compile/typecheck fold) are already done — see
`apps/devtools/AGENTS.md`. What remains is one capability gap, one design gap, and one live bug.

They are listed in the order I'd build them. The third is independent of devtools and probably
the most urgent, because it affects apps generally rather than only the dev loop.

---

## 1. `previewScreenshot` — let devtools see what it built

**Problem.** The devtools agent cannot look at pixels. Debugging a "renders blank" report, it
hand-wrote a throwaway `debugDom` state key that dumped `getBoundingClientRect()` and `innerHTML`
back through the protocol channel — four tool calls to answer *"is there a div on screen."* It
nearly shipped a wrong fix: every prior pointed at broken rendering, and the environment offers a
ready-made culprit (the `flex: 1` gotcha), but rendering was in fact fine. It got the right answer
only by distrusting its own diagnosis enough to go get evidence. That should not require virtue.

**The capability already exists.** Screenshots of iframe windows work today, end to end:

| Step | Where |
|---|---|
| Iframe self-captures (canvas → `toDataURL`, else DOM via `foreignObject` SVG) | `packages/shared/src/iframe-scripts/capture.ts` |
| Frontend requests it and returns base64 | `packages/frontend/src/store/iframe-bridge.ts:47,90,407` |
| `read yaar://windows/{id}` emits `window.capture` and returns an MCP image block | `packages/server/src/handlers/window.ts:220-242` |

A monitor agent reading a window gets a picture. The devtools agent does not — and the reason is
one guard:

```ts
// handlers/window.ts:219
const isIframeProxy = getAgentId()?.startsWith('iframe:') ?? false;
if (win.content.renderer === 'iframe' && !isIframeProxy) { /* capture */ }
```

Devtools' `viewPreview` runs *inside the devtools iframe* and reaches the server through
`POST /api/verb` as an `iframe:*` proxy. That path has no monitor-scoped context, so the capture
action's feedback has nowhere to round-trip, and the request would block for the full 5s timeout.
Skipping the capture was the right call given that. But it means the tool that builds the window
is the one tool that cannot see it.

**Why it's tractable.** The transport already carries images back to apps: `POST /api/verb`
extracts `type: 'image'` content blocks into an `envelope.images` array
(`packages/server/src/http/routes/verb.ts:107-117`) and the iframe SDK surfaces them
(`packages/shared/src/iframe-scripts/verb-sdk.ts:63`). App-protocol results pass image blocks
through untouched (`features/window/app-protocol.ts` `wrapAppValue`). So the only missing piece is
**monitor context for the emitted action**.

**Proposed fix.** Stamp the `window.capture` action with the *target window's* monitor rather than
resolving it from ambient agent context. `handleAppQuery` already does exactly this — it addresses
the window by its resolved, monitor-scoped key (`win.id`) precisely because the caller's monitor is
not necessarily the window's (`features/window/app-protocol.ts:118-121`). Teaching
`ActionEmitter.emitActionWithFeedback` to accept an explicit monitor, and passing `win.monitorId`
from the window read path, removes the reason the guard exists. The guard can then go, and
`viewPreview` returns a picture along with the metadata it already returns.

Add a `previewScreenshot` command as the ergonomic front door, and `previewInspect({ selector })`
if a targeted DOM read is still wanted after screenshots exist (it may not be).

**Scope:** one emitter signature, one call site, delete a guard. Contained.

---

## 2. Scoped sandbox identity for preview

**Problem.** `self` does not resolve inside a preview iframe — `no appId in iframe token`. So the
entire class of features that touches `appStorage`, `appDb`, or app-scoped permissions **cannot be
run even once before deploy**. The report's author shipped an app-storage sync feature having
never executed it:

> *"I compiled it, saw it fail safely, reasoned that `self` resolves in a real app, and shipped on
> that reasoning. That's not testing, that's an argument."*

The dev environment cannot run the code it exists to develop.

**Root cause.** `preview` creates a plain iframe window and passes no `appId`
(`apps/devtools/src/protocol.ts`), so `generateAppIframeToken` mints a token with
`appId: undefined` (`features/window/create.ts:175`). Every `self` resolution then 403s
(`http/routes/verb.ts:232,307`, `http/routes/files.ts:161`), and the token gets none of the
auto-granted self-storage permission (`http/iframe-tokens.ts:71-80`).

**Why the obvious fix is wrong.** Passing the *real* appId would resolve `self` — and introduce two
new problems. The preview window would register in `AppTaskProcessor.activeWindows` under
`(monitor, appId)` and become the "active" window for that app, so `getActiveAppWindow`
(`agents/context-pool.ts:462`) and cross-app `controls` messaging would start steering commands
meant for the **real, running app** into the preview iframe. And unshipped preview code would
inherit the real app's live storage namespace — precisely the blast radius we're trying to avoid.

**Proposed design — a preview-scoped principal.** Give the preview a real identity that is
*distinct from* the deployed app's:

- **Token.** Mint with `appId: {projectAppId}` plus a new `preview: true` flag (or a `previewOf`
  field naming the real app). `self` resolves; permission checks run for real.
- **Storage.** Redirect `yaar://apps/self/storage/*` and `appDb` to a preview namespace —
  `storage/apps/devtools/preview-storage/{appId}/` — at the point where `self` is expanded
  (`http/routes/files.ts:161` and the verb route's `self` resolution). Real code path, real
  permission gate, zero production blast radius.
- **Agent routing.** A preview window must **not** claim the app's `activeWindows` slot. Gate the
  registration in `AppTaskProcessor` on the token/window not being a preview.

Net effect: the previewed app runs the same code, through the same permission checks, against
storage that is thrown away. The report's own proposal, made safe against the `activeWindows`
misroute it didn't anticipate.

**Open question.** Should a preview get its own app agent? Today it gets none (no appId → no agent,
`agents/context-pool.ts:82-88`). Probably still none — devtools *is* the agent — but that falls out
of the `previewOf` design and should be decided explicitly rather than by accident.

**Scope:** touches iframe tokens, `self` expansion in two routes, and app-task registration. This
is the real design work of the three.

---

## 3. Duplicate windows: monitor-prefix key divergence

**This is a live bug affecting real apps, not a devtools problem.** It is what the report saw when
duplicate `ai-chat` windows "came back on their own" with no preview involved. It is *not* the
window-id collision from item 2 — that one replaces rather than duplicates.

**Mechanism.** The window registry key is `{monitorId}/{rawId}`
(`session/window-state.ts`). But `monitorId` is optional on every path, and it is resolved from
*ambient agent context*: `ActionEmitter.resolveMonitorId()` = `getMonitorId() ?? currentMonitorId`
(`session/action-emitter.ts:174-176`). Creates that originate over HTTP or the iframe-verb route —
i.e. **every app-initiated and devtools-initiated window** — can arrive with `monitorId:
undefined`. Then:

- Server falls back to a **bare** key, `"ai-chat"`, instead of `"0/ai-chat"`.
- `WindowHandleMap.resolve` also returns `undefined` rather than guessing when the same app is open
  on two monitors (`session/window-handle-map.ts:65-78`), producing the same bare fallback.
- The frontend independently recomputes the key: if the incoming id has no slash, it uses
  `action.monitorId ?? state.activeMonitorId ?? DEFAULT_MONITOR_ID`
  (`frontend/src/store/slices/windowsSlice.ts:103-109`).

So an unstamped `"ai-chat"` created while the user is looking at monitor 1 lands at `"1/ai-chat"`
on the frontend and `"ai-chat"` on the server, while an agent-created one sits at `"0/ai-chat"` —
**two visible windows for one app, and server/frontend keys that disagree.** Restore has the same
hole: `restoreFromActions` replays actions with no monitorId (`window-state.ts:275-285`).

Neither registry has any uniqueness assertion, so nothing ever surfaces the divergence.

**Proposed fix, in order:**

1. **Make the monitor explicit at the boundary.** A window create arriving without a monitor should
   resolve one *deterministically* — from the session's active monitor, server-side — rather than
   letting server and frontend each guess. One resolution, stamped once, before the action is
   broadcast.
2. **Make the invariant assertable.** Every key in both registries should be monitor-prefixed. A
   bare key is a bug; treat it as one (assert in dev, log in prod) instead of silently accepting it
   as a distinct window.
3. **Then decide the real semantics.** Two windows of one app on two monitors is *legitimate* —
   the raw-id-per-monitor design is deliberate (`window-handle-map.ts:16-23`). The bug is that a
   window can land on a monitor nobody chose. Fixing (1) and (2) makes the remaining question
   answerable.

The last four commits on `master` are all monitor-scoped window resolution fixes
(`e80aaa76`, `3e32b271`), so this is live territory — worth confirming against whatever motivated
those before building on top.

**Scope:** small change, but load-bearing. Do it before item 2, since item 2 adds another
app-initiated window-creation path into exactly this hole.
