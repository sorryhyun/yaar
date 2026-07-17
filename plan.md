# Server Refactoring Plan: Code Reduction & DevX

Consolidated plan from a four-subsystem audit of `packages/server/`. **Phases 1–4 are done and
committed** — see `git log --oneline -- plan.md` for the per-phase commits, each of which
records what the audit got wrong in its message and in the code comments it left behind.

What remains is below.

---

## 🔴 Open: app-agent storage traversal (found in 4.2, deliberately not fixed there)

`mcp/app-agent` has **no `..` guard**, and `storage/storage-manager.ts:31 resolvePath` only
confines to `STORAGE_DIR` — not to the app's own subtree. So `appStoragePath('notes',
'../devtools/secrets.json')` normalizes to `STORAGE_DIR/apps/devtools/secrets.json`, whose
`relative()` to `STORAGE_DIR` contains no `..` → **allowed**.

Reachable two ways:
- `query(stateKey: "storage/../other-app/secrets.json")` — reads another app's storage.
- `command("storage:list", {path: ".."})` — enumerates every app.

This contradicts the app-agent system prompt's own claim: *"Storage is scoped to this app — you
cannot access other apps' storage."* The verbs door (`handlers/apps.ts`) is **not** affected —
it calls `validateRelativePath`. Marked `KNOWN GAP` in the app-agent file header.

Left unfixed on purpose: it is a behavior change, and Phase 4 was a no-behavior-change refactor.
It wants its own reviewed commit, plus a regression test.

---

## Phase 5 — Optional file splits (cosmetic, lowest priority)

- [ ] `features/browser/actions.ts` (644 lines): keep the dispatcher + guard glue, move the
      ~22 leaf actions into `actions/navigation.ts`, `actions/dom.ts`, `actions/cookies.ts`,
      `actions/capture.ts`.
- [ ] `features/apps/discovery.ts` (450 lines): move the four `loadApp*` doc loaders
      (384-449) to `features/apps/docs.ts`; discovery keeps manifest→`AppInfo` assembly.
- [ ] URI sub-path parsers: move `parseAppStoragePath`/`parseAppDbPath` (`handlers/apps.ts:64-80`),
      `parseTarget` (`mcp/messaging/index.ts:47-60`) into `lib/yaar-uri-server.ts` alongside
      the existing `parseConfigUri`/`parseSessionUri` — centralizes the `..`-traversal guards.
      ⚠️ Note the open gap above: centralizing the guards is *not* the same as applying one to
      `mcp/app-agent`, which currently has none. Don't let this item imply that fix is done.

---

## Open follow-ups

- [ ] **`isError` on app-agent/messaging is now live** (1.4). Failures surface as error rows in
      the CLI panel and are flagged as errors to the model
      (`stream-to-event-mapper.ts:174`). Worth one manual smoke check that nothing downstream
      over-reacts to a routine failure.
- [ ] **Phase 4 never got its manual smoke run.** Its own verification section asks for
      `make claude-dev` → send a prompt → open an app window → interact. Typecheck and all 459
      server tests pass, but nothing has driven the real stack since the split.
- [ ] **Delete `relay` in favour of `direct_message(to:'monitor', end_turn:true)`** (surfaced by
      4.2). This is the real dedup between `mcp/app-agent` and `mcp/messaging`, but it removes a
      tool from the app agent's toolset, changes what the monitor's model reads (`relay` sends
      verbatim; `direct_message` wraps in `<from:app:{id}>` attribution tags), and touches
      `agents/profiles/types.ts`. Out of scope for a refactor.
- [ ] **Stale cross-references to this file.** Six sites cite `plan.md` for F-numbers and Slices
      that no longer exist in it — the server-refactoring plan overwrote that content at
      `04ad8463`. `packages/server/CLAUDE.md:229` and `http/access.ts:27` (F-23, the iframe
      same-origin gap), `tests/window-handle-scope.test.ts:128` (F-12/F-13),
      `tests/message-delivery.test.ts:3`, `tests/monitor-identity.test.ts:2` (Slice 3),
      `frontend/src/tests/store/resync.test.ts:3` (F-1/F-2),
      `docs/architecture/monitor_and_windows_guide.md:108` (Slice 3, F-7/F-10..F-14). Either
      restore those descriptions somewhere durable or repoint the references. **F-23 in
      particular is a live security gap whose only description is now gone.**

## Explicitly NOT doing

- **No further `base-transport.ts` unification** — the two providers' turn loops are
  genuinely different (persistent SDK stream vs per-turn JSON-RPC); more base-class would
  add abstraction without deleting code.
- **Leave alone (already-good prior extractions):** `agents/turn-helpers.ts`,
  `logging/session-logger.ts` (`appendEntry`), the `ResourceRegistry` URI routing,
  `http/server.ts`, `websocket/server.ts`, and the `state`-object seam in `AgentSession`'s
  constructor (deliberate — the three session-policies share live state through it).

## Verification per phase

1. `bun run typecheck`
2. `bun run --filter @yaar/server test`
3. Phase 4 additionally: one manual smoke run (`make claude-dev`, send a prompt, open an
   app window, interact) — per project memory, verify in a single run.

---

## Lesson for the next audit

Every Phase 3–4 item that survived contact with the code came back **smaller** than the audit
claimed, and four came back as *"this is not duplication"*: 4.2's storage layers are two
different doors (unforgeable vs caller-named appId — different threat models), 4.2's relay is
not a subset of `direct_message`, 4.3's stale-session retries are not byte-identical, and
`MonitorBudgetPolicy`'s seven early-returns don't share a return shape.

Phase 4 also finished **net +325 lines** against a promised −600–800, because file splits were
filed under "code reduction" when splitting is inherently additive. The wins were real but they
were single-sourcing and greppability, not size.

Treat audit findings as **hypotheses to verify**, not work orders.
