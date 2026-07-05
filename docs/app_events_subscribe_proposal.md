# Proposal: Declarative App→Agent Event Channels (Subscribe/Push)

**Status:** Draft for review
**Motivation:** Today the App Protocol is strictly *pull* — the agent calls `app_query`/`app_command` and the app answers. An app cannot proactively tell the agent "something happened" (a native dialog fired, a background job finished, the user did something inside the iframe). The one existing app-initiated path, `app.sendInteraction()`, is an unconditional one-shot that *always* spins up an agent turn — no declaration, no filtering, no subscription, no delivery-mode control.

This proposal adds **declarative event channels**: an app declares the channels it can emit, the agent subscribes to the ones it cares about, and emits are delivered only to subscribers — either **waking** the agent or **buffering** into its next turn.

---

## What already exists (reuse, don't reinvent)

| Piece | File | Role for this feature |
|---|---|---|
| `app.sendInteraction()` iframe→agent push | `packages/shared/src/iframe-scripts/app-protocol.ts:37` | Transport precedent; the new `app.emit()` mirrors its postMessage shape. |
| Pending-event drainer | `packages/frontend/src/hooks/use-agent-connection/usePendingEventDrainer.ts:88` | Where the new `APP_EVENT` WS frame is sent. |
| `WindowSubscriptionPolicy` | `packages/server/src/agents/context-pool-policies/window-subscription-policy.ts` | Subscription registry + debounce + `deliverTask`. Already typed for `subscriberType: 'monitor' \| 'app'`; app branch stubbed. **Generalize its event key from the `WindowChangeEvent` enum to arbitrary channel strings.** |
| `subscribe.ts` agent tool | `packages/server/src/features/window/subscribe.ts:33` | Hardcodes `subscriberType='monitor'` — un-hardcode. Template for the new `app_subscribe` tool. |
| `InteractionTimeline.pushAI` | `packages/server/src/agents/app-task-processor.ts:148` | Precedent for **buffer** mode (drain into next turn, no wakeup). |
| `pool.handleTask()` | `packages/server/src/agents/context-pool.ts` | The enqueue primitive for **wake** mode. |
| Verb-subscription registry | `packages/server/src/http/subscriptions.ts` | Registry pattern reference (server→iframe direction). |

---

## Model & semantics

### Declaration (app side)
An app declares channels in its `app.register()` call, alongside `state` and `commands`:

```ts
app.register({
  appId: 'browser-user',
  events: {
    dialog:   { description: 'A native alert/confirm/prompt fired on a driven tab.' },
    navigated:{ description: 'A driven tab finished loading a new URL.' },
  },
  state: { ... },
  commands: { ... },
});
```

Declared channels surface in the manifest (`describe yaar://apps/<id>` / the protocol manifest handler), so an agent can discover what it may subscribe to. **Undeclared emits are dropped** with a server-side warning (keeps the surface honest).

### Emit (app side)
```ts
app.emit('dialog', { kind: 'alert', message: '글 내용을 입력하세요' });
```
Fire-and-forget from the iframe. Payload is arbitrary JSON (size-capped).

### Subscribe (agent side)
A new MCP tool available to the **monitor agent** (and optionally app agents):
```
app_subscribe(windowId, channels: string[], mode: 'wake' | 'buffer' = 'wake')
app_unsubscribe(subscriptionId)
```
- `channels: ['*']` subscribes to all declared channels.
- Subscriptions are keyed by `subscriberAgentKey + windowId + channel` (same shape as `WindowSubscription`).
- Subscriptions auto-expire when the window closes (reuse the `close` teardown already in `WindowSubscriptionPolicy`).

### Delivery modes
- **`wake`** — emit → `pool.handleTask({ type:'monitor'|'app', content:<app:event…> })`. Debounced (reuse existing 500ms default; per-channel overridable). Use for things needing immediate reaction (dialog, error, job-done).
- **`buffer`** — emit → appended to a per-agent **pending-events buffer**; `ContextAssemblyPolicy` drains it into the *next* prompt the agent runs for that monitor. No wakeup, no cost until the agent runs anyway. Use for ambient signal.

### Task framing
Delivered to the agent as:
```
<app:event window="browser-user" channel="dialog">
{"kind":"alert","message":"글 내용을 입력하세요"}
</app:event>
```
Consistent with the existing `<window:change>` / `<app_interaction>` framing.

### Loop / cost guards
- Debounce per (subscriber, window, channel) — already in the policy.
- **Self-emit suppression**: an emit caused by the agent's own action shouldn't wake it (mirror `sub.subscriberAgentKey === sourceAgentKey` skip at `window-subscription-policy.ts:110`).
- Per-window emit rate cap (drop + warn beyond N/sec) to stop a chatty app from DoS-ing the agent.
- Payload size cap (e.g. 4KB) — larger truncated with a note.

---

## Data flow (wake mode)

```
iframe: app.emit('dialog', payload)
  → postMessage { type:'yaar:app-event', windowId, channel:'dialog', payload }
  → [frontend] iframeMessageRouter whitelist → iframe-bridge handler → pending queue
  → [drainer] send({ type: APP_EVENT, windowId, channel, payload })         (WS)
  → [server] live-session.routeMessage → pool.notifyAppChannel(windowId, channel, payload)
  → WindowSubscriptionPolicy: match subscribers, debounce, self-skip
  → deliverTask(<app:event…>) → pool.handleTask → agent turn
```

Buffer mode diverges at the last step: instead of `handleTask`, append to the monitor's pending-events buffer read by `ContextAssemblyPolicy`.

---

## Change inventory

**Shared** (`packages/shared`)
1. `events.ts` — add `ClientEventType.APP_EVENT` + `AppEventEvent` schema `{ windowId, channel, payload, messageId }`.
2. `iframe-scripts/app-protocol.ts` — add `app.emit(channel, payload)`; extend `register()` to accept `events`; include `events` in the manifest reply.
3. (types) app-registration type gains `events?: Record<string, { description: string }>`.

**Frontend** (`packages/frontend`)
4. `lib/iframeMessageRouter.ts` — whitelist `yaar:app-event`.
5. `store/iframe-bridge.ts` — handler → `addPendingAppEvent(...)`.
6. `store/...` — a `pendingAppEvents` queue (mirror `pendingAppInteractions`).
7. `use-agent-connection/usePendingEventDrainer.ts` — drain `pendingAppEvents` as `APP_EVENT`.

**Server** (`packages/server`)
8. `session/live-session.ts routeMessage` — handle `APP_EVENT` → `pool.notifyAppChannel(...)`.
9. `agents/context-pool.ts` — add `notifyAppChannel(windowId, channel, payload)`; buffer plumbing for buffer mode.
10. `agents/context-pool-policies/window-subscription-policy.ts` — generalize event key to `string`; add channel-subscription support (or a sibling `AppChannelSubscription` map sharing the debounce/deliver code).
11. `agents/context-pool-policies/context-assembly-policy.ts` — drain pending app-events buffer for buffer mode.
12. `features/window/subscribe.ts` — un-hardcode `subscriberType`; add `app_subscribe`/`app_unsubscribe` handlers (channels + mode).
13. `mcp/app-agent/index.ts` and/or the monitor-agent tool registry — expose the subscribe/unsubscribe tools + surface declared `events` in `describe`.

**Consumer** (`apps/browser-user`)
14. `src/protocol.ts` — declare `events: { dialog, navigated }`.
15. Sync dialogs: returned in the click/type **command result** (Phase 0, separate from this system).
16. Async dialogs (extension-sourced): extension pushes a `dialog` frame over the bridge WS → server forwards to the iframe (reuse the server→iframe notification push) → iframe re-emits via `app.emit('dialog', …)`. **Most speculative; last.**

---

## Phasing

- **Phase 0 — Dialog bug fix (independent, ships now).** MAIN-world `alert/confirm/prompt` capture around click/type dispatch in `extension/background.js`; return `dialogs[]` in the command result. Solves the *reported* symptom with zero new infra. (Scroll `undefined`-serialization fix already landed.) — *Not yet done (extension work, independent).*
- **Phase 1 — Emit transport. ✅ DONE.** SDK `app.emit()` + `register({events})`, `APP_EVENT` WS frame, frontend queue/drainer, `routeMessage` → `notifyAppChannel`. Declared events flow through the app-protocol manifest (`app_query` manifest → `events`) and static `protocol.json`.
- **Phase 2 — Subscribe + wake delivery. ✅ DONE.** `WindowSubscriptionPolicy` generalized (channel subs alongside window-change subs), `app_subscribe`/`app_unsubscribe` actions on `yaar://windows/{id}`, debounce + self-skip + per-window rate cap (20/s) + 4KB payload cap, `<app:event window=… channel=…>` framing.
- **Phase 3 — Buffer mode. ✅ DONE (via timeline).** `mode:'buffer'` folds the framed event into the monitor agent's next turn via `InteractionTimeline.pushRaw` (drained by `ContextAssemblyPolicy`), no wakeup. *Note: the timeline is pool-global, not strictly per-monitor — acceptable simplification, matches existing app→monitor relay.*
- **Phase 4 — browser-user async dialogs.** Extension→server→iframe forwarding, then `app.emit('dialog')`. — *Not yet done. `browser-user` now declares the `dialog`/`navigated` channels (discovery-ready); the extension push path remains.*

Each phase is independently testable; Phase 0 is shippable on its own. **Open decisions resolved as implemented:** monitor-agent subscribers only (#1); default mode `wake` (#2); undeclared emits are dropped by having no subscribers rather than a strict manifest check (#3 — softer than recommended, avoids server-side manifest caching); session-scoped subscriptions (#4); `WindowSubscriptionPolicy` extended in place (#5).

---

## Open decisions (need sign-off)

1. **Subscriber scope:** monitor agent only to start, or app agents too? (Recommend: monitor first; app-agent subscribe is a small add later.)
2. **Default mode:** `wake` or `buffer`? (Recommend: `wake` for explicit subscriptions — the agent asked to be notified.)
3. **Declaration strictness:** drop undeclared emits (recommended) vs allow ad-hoc channels.
4. **Persistence:** do subscriptions survive reconnect/restore, or reset per session? (Recommend: session-scoped, reset on new session — matches window state.)
5. **Reuse vs sibling:** extend `WindowSubscriptionPolicy` in place (channels as strings) vs add a parallel `AppChannelSubscriptionPolicy`. (Recommend: extend in place — the debounce/deliver/close-teardown is identical; only the event key widens.)
