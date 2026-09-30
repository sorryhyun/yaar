# Proposal: app state snapshots — checkpoints for window history

> **Status:** closed. The snapshot/hydrate design (§1–4 of the original, 2026-08-28) is
> **superseded** by `createSharedSignal`, and was not built. The two parts of it that still
> held have shipped in a different form (below). What is left open is listed at the end.

## The problem it set out to solve

A YAAR app that is reloaded, remounted, or restored to a history seq comes back empty and is
rebuilt by **replaying the commands agents sent it** (`AppWindowCoordinator.replayCommands`).
Replay has three faults: it double-applies anything with a side effect, it only restores what
*agents* did (never what the user typed or chose), and it costs one iframe round trip per
command. The proposal was to snapshot every `snapshot: true` state key through `app_query`
before the server tears a document down, and hand the snapshot to the next document in a
`yaar:app-hydrate` message instead of replaying.

## Why it was not built

`createSharedSignal` (`packages/compiler/src/shims/yaar/reactive.ts`, landed 2026-09-21) keeps
a window-scoped value on the server, written on **every set**, and a copy that mounts later
starts from it. That covers the user-state half of the problem, and covers it better:

- **It covers the remounts the server never sees coming.** A snapshot has to be *taken* before
  the document goes, so the server can only take one when it causes the remount (an explicit
  `reload`, a restore). The common remounts are the ones it does not cause: a page reload, a
  dev-bundler live reload, a phone returning from another app, a reconnect. The original plan
  covered those only with a periodic snapshot (its Phase 4), which is always somewhat stale. A
  value written on every set is never stale.
- **It is one mechanism, not two.** Configurations, storage, search, session-logs, lab,
  market-apps and browser already hold state this way, and devtools moved its open projects
  into a shared value for exactly the remount reason (`apps/devtools/src/services/projects.ts`).

Two of the original's premises were also wrong by the time it was reviewed:

- **Redeploy is not a remount.** `retireStaleApp` *closes* the stale windows
  (`features/apps/retire.ts`); only the deployer's own window survives, and it is reloaded later
  by the caller. There is no document to hydrate into. That removes the redeploy trigger and
  the app-git `withState` restore (Phase 3) with it.
- **`browser` was the wrong first adopter.** Its tabs and URL are a mirror of the server-side
  Chrome session, so they already survive a remount.

## What shipped instead

1. **History restore rewinds shared values** (the original §5 checkpoint, redefined).
   `restore(upTo)` truncated the command log but left shared values at their newest state, so
   the kept commands replayed on top of the state the restore was meant to go back before.
   Every history entry now records the shared-value rev at the moment it was filed
   (`WindowHistoryEntry.sharedRev`). A restore resets the values set after the kept entry
   (`windowSharedStore.rewindWindow`) and names them in its response. A value last set before
   the entry stays. It is a rewind, not a snapshot: earlier versions of a value are not kept,
   so a key set both before and after the mark restarts from `initial` and is rebuilt by the
   replayed commands. Test: `packages/server/src/tests/window-history.test.ts`.
2. **An app-level replay default.** `defineApp({ replay: 'never' })` is the policy of every
   command that declares none, and a command can still say `replay: 'always'`. This is the
   original's aim ("replay is the fallback for apps that don't opt in") without a hydrate
   message. It is for apps whose state a remount reads back anyway, where replay only re-runs
   commands on top of restored state. `defineApp` and the build both resolve it per command,
   so the ready handshake's `noReplay` list and `protocol.json` carry each command's
   effective policy and the server needed no change. First adopters: `mcp-manager` and
   `remote-control`, whose every command was already `never`.

## Principles from the original that still stand

- The agent gets no write path into app state. An agent sets state by invoking a command.
- `appDb` / `appStorage` are never copied into a second store that could disagree with them.
- Replay stays as the fallback, and `replay: 'never'` stays documented.

## Still open

- **Server-side at-most-once replay.** Nothing here stops an app that declares no policy from
  double-applying a mutation on remount.
- **devtools still replays 18 commands**, among them `compile`, `preview`, `selfTest` and
  `httpProbe`. Its open projects are already in a shared value, so it is the next candidate for
  the app-level default. That would change behavior, so it needs checking live before it lands.
- **A restore cannot bring back a value's earlier version** (see item 1). Keeping a per-key
  journal would allow it, at up to twice the memory of the 32 MB per-window cap. Not worth it
  until a restore is observed losing user state that mattered.
