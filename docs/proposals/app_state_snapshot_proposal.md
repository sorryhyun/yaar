# Proposal: app state snapshots — checkpoints for window history

> **Status:** proposal. Not implemented. The half of the original idea that *is* implemented is
> `yaar://windows/{id}/history` (`features/window/history.ts`): every `app_command` a window
> received, listable and readable by agents, with `restore(upTo)` truncating the log and
> remounting so the kept commands replay. This document is about what that history cannot
> hold, and how to add it.

A YAAR app that is redeployed, reloaded, remounted, or restored to a history seq comes back
empty and is rebuilt by **replaying the commands agents sent it**
(`AppWindowCoordinator.replayCommands`). That is the only mechanism there is, because the app
protocol can *read* an app's state (`app_query` → a state key's `handler()`) but has no way to
*write* it back into a fresh document. This proposal adds that missing direction: a **state
snapshot** taken before the document goes away, and a **hydrate** message that hands it to the
next one. Replay becomes the fallback for apps that don't opt in, not the design.

Once a snapshot exists it becomes a **checkpoint** — a history entry that carries the state the
window was in, not just the command that got it there. `restore(upTo)` to a checkpoint hydrates
instead of replaying, which is what makes "put the window back" mean the *user's* window and not
only the agent's. The same checkpoint, stored beside the shadow-git commit every deploy makes
(`features/dev/git.ts`), turns app-git history from *code revisions* into *code + the state it
was running with*.

## Why replay is the wrong primitive

Replay reconstructs state by re-running history. Three things follow:

1. **It double-applies anything with a side effect.** `replay: 'never'` exists to opt single
   commands out (`addMemo`, `deleteMemo`), and the coordinator names how many it skipped, but
   every app author has to find each such command by hand, and every command that is skipped is
   a piece of state that is *not* restored. The known iframe-remount duplication bug is this
   design, not a bug in it.
2. **It only knows what the agent did.** State the *user* produced inside the window — typed
   text, a selected tab, a scroll position, an unsent draft — was never a command and is gone.
   Replay restores the agent's view of the app, not the app. `…/history` says this in every
   `restore` response; it cannot fix it.
3. **It scales with history.** N commands means N round trips through the iframe's request
   lifecycle on every reload. A snapshot is one message.

Apps whose state lives in `appDb` / `appStorage` (memo, lab's persistence layer) already survive
a remount; nothing here is for them. This is for the in-memory state every other app holds
between two events.

## The test

> A state key belongs in the snapshot if losing it on reload would make the user say
> "wait, where did my … go?" — and if the value round-trips through JSON unchanged.

Derived values (a filtered list, a computed total), caches, and anything reconstructible from
`appDb` fail the test and stay out. Opt-in per key, never per app: the declaration is the
contract, and an undeclared key is a decision, not an omission.

## Design

### 1. Declaration — `snapshot` on a state key

`AppStateDescriptor` (`packages/shared/src/app-protocol.ts`) gains one field, mirroring how
`replay` sits on `AppCommandDescriptor`:

```ts
export interface AppStateDescriptor {
  description: string;
  schema?: object;
  /** Omitted means `false` — old apps keep today's replay behavior. */
  snapshot?: boolean;
}
```

The compiler carries it into `dist/protocol.json`; the running registration carries it in the
ready handshake the same way `noReplay` already rides `AppProtocolReadyEvent` — from the
document that is actually up, never from disk, for the same reason the replay policy does.

### 2. Registration — a `hydrate` handler

`defineApp` accepts an optional top-level `hydrate`:

```ts
export default defineApp({
  id: 'browser',
  state: {
    tabs: { description: 'Open tabs and the active one', get: () => tabsSnapshot(), snapshot: true },
  },
  hydrate: (state, ctx) => {
    // state: { tabs: … } — only the keys declared snapshot: true, only those that were taken
    // ctx.revision: the app version / git ref the snapshot was taken under
    restoreTabs(state.tabs);
  },
  …
});
```

`hydrate` is the whole opt-in. An app that declares `snapshot: true` keys but no `hydrate` is a
lint error (`scripts/check/apps.ts`, `snapshot-without-hydrate`, ERROR) — a snapshot nobody
consumes is a promise the app makes and breaks.

### 3. Taking the snapshot — server side, before the document goes

`AppWindowCoordinator.snapshotState(windowKey)` queries every `snapshot: true` key through the
existing `app_query` path and stores `{ appId, revision, takenAt, state }` in
`WindowStateRegistry` beside `appCommands` / `appNoReplay` (same key, same lifetime, dropped by
the same cleanup). It is called from:

| Trigger | Where | Why this moment |
|---|---|---|
| Redeploy | `doDeploy()` before `retireStaleApp` | The stale window is about to run old code; `staleWindow` already names it |
| Desktop-initiated reload | the `window.reload` action path | The iframe is about to remount by our own hand |
| Periodic (optional, Phase 4) | idle tick in the coordinator | Covers the cases we don't initiate: a crashed tab, a closed laptop |

A snapshot is **best-effort**. A key whose handler throws, or whose value exceeds the cap, is
skipped and named in the log the way `replayCommands` names skipped commands — the snapshot
proceeds with the rest. A window with no ready registration has nothing to snapshot and the
call is a no-op.

### 4. Hydrating — one message, then no replay

New inbound iframe message, delivered by the coordinator right after `handleReady` accepts a
re-registration (`wasReady && !reannounce` — the exact branch that replays today):

```json
{ "type": "yaar:app-hydrate", "requestId": "hyd-…", "state": { "tabs": … }, "revision": "1.0.2" }
```

The injected protocol script (`packages/shared/src/iframe-scripts/app-protocol.ts`) calls the
registration's `hydrate` and replies `{ ok: true }` or `{ ok: false, error }`. The decision
tree in `handleReady` becomes:

```
re-registration?
  no  → nothing (first mount)
  yes → snapshot stored AND app declares hydrate?
          yes → send hydrate
                  ok    → done. No replay.
                  error → replay (today's path), log the hydrate failure
          no  → replay (today's path)
```

`reannounce` stays exactly what it is: a document that never remounted receives neither a
hydrate nor a replay.

### 5. Checkpoints — the snapshot rides the history entry

A snapshot taken in §3 is filed in the window's history (`WindowStateRegistry`, beside the
`command` and `event` entries `…/history` already lists) as a `checkpoint` entry:
`{ kind: 'checkpoint', seq, at, revision, keys: [...] }`, the state itself held out of the
listing and served by `read('…/history/{seq}')`. `restore(upTo)` then does one more thing
than today: if a checkpoint exists at or before `upTo`, it is staged as the pending hydrate,
and only the commands *after* that checkpoint are left to replay. An agent can also ask for
one explicitly — `invoke('…/history', { action: 'checkpoint' })` — before a risky sequence.

### 6. App-git — the same snapshot rides the commit

`snapshotApp(appId, message)` in `features/dev/git.ts` commits source on every deploy. The
snapshot taken in §3 for the redeploy case is written to
`storage/app-git/<appId>.snapshots/<commit>.json` (beside the bare repo, never inside it — the
repo's `EXCLUDE_PATTERNS` and the user's own git stay clean). `appHistory()` gains
`hasSnapshot: boolean` per commit; `restoreApp(appId, ref)` gains `{ withState?: boolean }`,
which after the restore-and-recompile stages the stored snapshot as the pending hydrate for the
app's next registration.

That is the whole link between "fast reload", "restore with state" and "revert with state":
one entry kind in the history, one file per commit and two flags. The history UI the devtools app would hang off this (a timeline of prompt + diff +
revert) is out of scope here and needs nothing beyond `hasSnapshot`.

## Caps and failure modes, decided up front

- **Size.** 256 KB per key, 1 MB per snapshot, JSON-serialized. Oversize keys are skipped and
  named. The numbers are a starting point; the *shape* — per-key and per-snapshot, skip-not-fail —
  is the decision.
- **Schema drift.** A snapshot from revision N may not fit revision N+1's state. `hydrate`
  receives `ctx.revision` and decides; if it throws, the coordinator falls back to replay. A blank
  window is never the outcome of a failed hydrate.
- **Non-JSON values.** `Date`, `Map`, class instances, functions, cycles: the state getter's
  return is passed through `JSON.stringify` at snapshot time and a value that fails is skipped
  and named. The lint rule can't catch this statically; the log can.
- **Two clients, one session.** The snapshot is keyed by window, like `appCommands`; two
  desktops showing the same window register the same key and would each receive the hydrate.
  This is the same situation replay is in today and inherits the same answer (`reannounce`).
- **Staleness.** A periodic snapshot (Phase 4) can be older than the document's last change.
  That is still strictly better than replay's answer, which is "never had it".

## What this deliberately does not do

- **It does not persist across server restart.** Snapshots live in `WindowStateRegistry`
  memory, like readiness and the command log. The history-side copy (§5) is the durable one,
  and only for deploys. Extending §3's periodic snapshot to disk is a follow-up with its own
  retention question.
- **It does not replace `replay: 'never'`.** Apps that never opt in behave exactly as today.
  The field stays, and stays documented.
- **It does not make state writable by the agent.** `yaar:app-hydrate` is coordinator-to-iframe
  only, sent in exactly one place. An agent that wants to set state still invokes a command.
  Exposing hydrate as a verb would be a second, un-audited write path into the app.
- **It does not snapshot `appDb` / `appStorage`.** Already durable; snapshotting it would be a
  second copy that can disagree with the first.

## Phases

| # | Deliverable | Touches | Adopter |
|---|---|---|---|
| 1 | `snapshot` field, `hydrate` registration, `yaar:app-hydrate` message, coordinator branch, lint rule | `shared/app-protocol.ts`, `shared/iframe-scripts/app-protocol.ts`, `compiler` (manifest passthrough), `server/session/app-window-coordinator.ts`, `window-state.ts`, `scripts/check/apps.ts` | one app with real in-memory state — `browser` (tabs/url) is the candidate; **not** memo, whose state is already `appDb`-backed |
| 2 | `checkpoint` history entries; `restore(upTo)` hydrates from the nearest one; explicit `checkpoint` action | `session/window-state.ts`, `features/window/history.ts`, `handlers/window.ts` | same app as Phase 1 |
| 3 | Snapshot on redeploy; stored beside the commit; `hasSnapshot` / `withState` on app-git history + restore | `features/dev/deploy.ts`, `features/dev/git.ts` | devtools' own preview window |
| 4 | Periodic snapshot for un-initiated remounts | coordinator idle tick | any Phase-1 app, free |

Phase 1 is shippable alone and already removes the replay path for every app that adopts it.
Phase 2 is where `…/history` stops being "what agents did" and becomes "where the window was".
Phase 3 is where the report's "provenance + rollback" and "state-preserving edit" stop being two
features.

## Acceptance

- Reload a Phase-1 app with user-produced state (text typed, tab chosen): it comes back with that
  state and **zero** replayed commands in the log.
- Redeploy the same app from devtools: `staleWindow` reloads and comes back with state; the
  commit for that deploy has `hasSnapshot: true`.
- `restore(upTo)` to a seq at or after a checkpoint: the window comes back with the user's
  state from the checkpoint plus only the commands after it replayed.
- `restoreApp(id, ref, { withState: true })` to an older commit: the window shows that
  revision's code *and* its state.
- Break `hydrate` on purpose (throw): the window still comes back, via replay, and the log names
  the hydrate failure.
- An app declaring `snapshot: true` without `hydrate` fails `bun run check:apps`.
