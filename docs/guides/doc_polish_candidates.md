# Doc polish candidates

Worklist produced by sweeping the repo with the method in
[`doc_polish_case.md`](./doc_polish_case.md). Not a finished plan — a list of every
suspicious item found, so none has to be re-found. Unordered; fix in whatever batches
group well.

**Status (2026-07-27):** all `wrong` / `fiction` / `phantom` / `dup` / `fmt` rows have been
fixed and re-verified against source; those rows are removed below. What remains is the
**adding** work — `gap` (real surface undocumented) and `drift` (EN/KO mismatch) — plus a
few judgment calls noted inline. Line numbers below predate the cleanup and may have
shifted; locate by text.

One audit row turned out to be wrong and was dropped rather than fixed:
`multi_window_apps_proposal.md:263`'s cited commit `9b941ed3` **does** exist in this repo
(`git cat-file -t` confirms) and matches the doc's description — the citation stands.

**Type** — `gap` real surface undocumented · `drift` EN/KO mismatch.

**Ev.** — `✓` means the claim was re-checked against source while building this list.
Unmarked rows are reported but unverified; check before acting.

---

## Detector gaps (feedback for `doc_polish_case.md` — the ranking script misses these classes)

| Type | Item | Ev. |
|---|---|---|
| gap | `doc_polish_case.md:24` globs `find docs -name '*.md'`. The largest confirmed phantom cluster (`?? '0'`, 10 restatements) was entirely in `.ts` and scored zero | ✓ |
| gap | Positively-phrased phantoms score zero — `sqlite.md` restated one absence 6× as "Purely additive", "No conflict — parallel systems". Density: 1 hit / 527 lines | ✓ |
| gap | `docs/ko/*` scores 0.0 by construction; terms are English. Needs `더 이상`, `없습니다`, `제거`, `않습니다` | ✓ |
| gap | Checklist has no "confirm the absence is real" step. Several `there is no X` warnings were false (the `devtools/AGENTS.md` session-URI claim) — and one audit row itself failed this test (`9b941ed3` above) | ✓ |
| gap | Doc frames phantoms as noise; they decay into `wrong`. `monitor-identity.test.ts` held a phantom that became a false present-tense claim citing 4 dead line refs | ✓ |

---

## Remaining `gap` rows — undocumented real surface (adding work, not cutting)

### `packages/server/CLAUDE.md`

| Line | Item | Ev. |
|---|---|---|
| ~125-129, ~234-238 | MCP map + Tools table omit `app-agent/` and `messaging/` (2 of 5 `CORE_SERVERS`); `external/` appears in no CLAUDE.md at all | |
| ~117-124 | `handlers/` omits `define-actions.ts`, `history.ts`, `http.ts`, `mcp-gateway.ts`, `storage-bytes.ts`, `apps/agents-resource.ts` (the last is discussed later in the same file) | |
| ~130-136 | `features/` omits `agents/`, `market/`, `session/`, `skills/`, `user/` | |
| ~141-144 | `lib/` omits `tunnel/`, `download/`, `ssrf.ts`, `errors.ts`, `ids.ts`, `image.ts`, `open-url.ts`, `format-verb-log.ts` (root `CLAUDE.md`'s `lib/` list is now accurate — mirror it) | |

### `packages/shared/CLAUDE.md`

| Line | Item | Ev. |
|---|---|---|
| ~21 | `iframe-scripts/` list omits `ime-guard.ts`, `console-capture.ts`, `prelude.ts` | |

### `apps/`

| Location | Item | Ev. |
|---|---|---|
| `devtools/AGENTS.md:~73` | "All app metadata lives in `app.json`" list omits `personas`/`subagents` and `streams`. devtools authors other apps' manifests | |

### `docs/architecture/` + `docs/proposals/`

| Location | Item | Ev. |
|---|---|---|
| `os_presence_bridge_proposal.md` | No `Status:` header (sibling has one). 0% shipped — `MprisWatcher`, `mpris`, `yaar://browser/presence` all 0 hits | |
| `os_presence_bridge_proposal.md:99` | Attributes "widen it by extraction, never by exception" to established precedent; phrase appears nowhere else | |
| `multi_window_apps_proposal.md:~103-106` | (found during cleanup) "Design" section still says the launch snippet "must … stop hardcoding `yaar://windows/${appId}`", but the current snippet (`agents/profiles/shared-sections.ts:66`) already uses the bare-collection form | |

### `docs/guides/`

| Location | Item | Ev. |
|---|---|---|
| `sqlite.md` | Genre misfiling: `## Motivation`, `## Design Decisions`, `## Implementation Status`, `## Risks & Mitigations` — a landed RFC filed under how-to. (`← NEW:` annotations and the phantom restatements are already cleaned.) Moving it to `proposals/` is the remaining call | |

### `docs/reference/`

| Location | Item | Ev. |
|---|---|---|
| `uri_reference.md:~96` | 5 window actions documented; `handlers/window.ts` defines 15. Undocumented anywhere: `lock`, `unlock`, `move`, `resize`, `app_eval`, `app_subscribe`, `app_unsubscribe` | |
| `uri_reference.md` | `yaar://config/mcp[/*]` absent from the Config table despite being registered and self-advertised by `read('yaar://config/')` | |
| `uri_reference.md:~223-229` | `read` documented as `{uri}`; takes six params incl. the whole PDF contract (`lines, pattern, context, pdfText, pdfPages`) | |
| `uri_reference.md` | Brace expansion undocumented — all five verbs run `expandBraceUri` and fan out in parallel; every tool description advertises it | |
| `uri_reference.md:~383-391` | iframe SDK table omits `stream()` and `fetch()`; `stream` is what this doc's own sub-agent section depends on | |
| `app_protocol_reference.md:~84-107` | Manifest interfaces omit `keybindings` and `replay` — two whole features, both extracted into `protocol.json` | |
| `storage_api_reference.md:~443-455` | `Settings` omits `remote: boolean` (in `DEFAULTS`, read at boot) | |
| `codex_protocol.md` | `thread/tokenUsage/updated` undocumented despite mapping to a distinct `usage` shape with cache-token subtraction. `IGNORED_METHODS` has 17 entries vs ~7 in the table | |
| `os_actions_reference.md` | `window.close` is lock-protected (`windowsSlice.ts:152-158`) but documented as unprotected — silent rejection with no debugging pointer | |
| `os_actions_reference.md` | `appOrigin` on `window.create` undocumented in all of `docs/` — the proxy-port counterpart to `isolateOrigin` | |
| `openapi.yaml` | 10 registered routes undocumented: `/api/sessions`, `/api/settings` GET+PATCH, `/api/domains` GET+PATCH, `/api/providers`, `/api/pick-directory`, `/api/remote-info`, `/api/agents/stats`, `/api/iframe-token`, `/api/shortcuts` GET+POST, `/api/dev/preview/{appId}`. 28 declared paths, none stale | |
| long tail | Toast `duration` default 5000ms · `UserPromptInputField` type enum `text\|textarea\|password` · `UserPromptOption.description` · `cols` accepts coerced number + JSON string · `window.focus` "Panels are unaffected" half-true · `app_subscribe` `debounceMs` · command `timeoutMs` 1s floor · `configStatMtime` · MIME/upload source is `config/assets.ts` | |

Framing note: `os_actions_reference.md`'s source is **not** Zod — `packages/shared/src/actions.ts` has zero Zod imports. OS Actions are type-level only; just `components.ts`/`bridge.ts` validate at runtime.

---

## `docs/ko/` — translation drift (remaining)

Root cause: seven EN commits never got a KO counterpart — `b93c96e`, `f867dad`, `bf0ec71`,
`4900fa6`, `b6ecef3`, `8db8aef` (app-development) and `8673cce` (remote_mode). The three
clean pairs are clean because every commit touching them touched both languages.

The two `wrong`-severity KO items (DOMPurify teaching the forbidden import; `19개`) are
fixed; what remains is untranslated content:

| Location | Item | Ev. |
|---|---|---|
| `ko/app-development.md` | `## Sub-agents (Personas)` + 3 subsections (EN ~1295-1414, 120 lines, 4 code blocks) absent. `personas`/`subagents`, `streamUri`, `reused:true`, `persona:*`, the 12-tool/6000-char limits, and the capability laws are undocumented in Korean | ✓ |
| `ko/app-development.md` | `### Never trust a read either — validate at the boundary` (EN ~1098-1159) absent — no `z.safeParse`, `z.looseObject`, `parsed.error.issues`, no "degraded-by-design must be distinguishable from broken" | |
| `ko/app-development.md:~688-733` | `defineApp()` 6-bullet API reference dropped (EN ~786-822). `replay` (EN 8 / KO 0) and `keybindings`/`onShortcut` (EN 2 / KO 0) are 100% undocumented, incl. the combo grammar and reserved list. KO sample omits `replay: 'never',` | |
| `ko/app-development.md` | `createStaleGuard` absent (EN ~406-427, EN 6 / KO 0). KO ~963 import line silently drops it mid-block; `revive` lost from the `createPersistedSignal` paragraph (EN 3 / KO 0) | |
| `ko/app-development.md:~610-642` | `app.json` table missing 2 rows: `streams` and `personas`/`subagents` | |
| `ko/app-development.md:~571, ~792` | Pre-`b93c96e` prompt-priority text; `buildProtocol(ctx)` where EN says `registerProtocol(ctx)` | |
| `ko/common_flow.md` | Missing `### 5. Sub-agent — the app's worker thread` (EN ~95-121) and `### App state across app-agent handoffs` (EN ~306-319) | |
| `ko/remote_mode.md` | `### YAAR_REMOTE_TOKEN` never translated (EN ~80-89). KO ~73 omits "a fresh one per start … rescan the QR"; KO ~78 omits `/health`'s `{status, remote}` | |

In sync, checked: `ko/faq.md`, `ko/hooks.md`, `ko/sqlite.md`, `ko/yaar_ml_runtime.md`.
The `5b2cf03` LAN cleanup is complete and correct in Korean — `grep -ow LAN` = 1 each,
no dead anchors, banner consistent. Do not redo it.

---

## Checked and cleared — do not cut

Listed so they are not re-flagged. Each was a candidate; each survived verification.

- `session/action-emitter.ts` "A late reply used to be dropped in silence" — the
  case study's own named keeper; `loopback-late-reply.test.ts` pins the behavior it
  explains. Also the `expiredDialogs` and session-keyed `readyWindows` comments — same
  class, each names a real shipped bug.
- `session/monitor-registry.ts:1-18` "There is deliberately no `activeMonitorId` here."
- `http/access.ts:105-121`, `http/auth.ts:63-70` and `:149-155` — live security shapes.
- `shims/yaar/define-app.ts:340-348` "Please do not 'simplify' `typeof document` away."
- `tests/security/html-sanitization.test.ts:18-28` (jsdom vs happy-dom) and `:181-186`
  (why the roster is scanned, not listed).
- `config/env.ts:189-215` — live operational constraint with an action.
- `packages/server/CLAUDE.md` sub-agent `never`s (~8) — eight *different* mechanisms in
  eight files, not one argument restated.
- `packages/server/CLAUDE.md` `YAAR_BROWSER_PROVIDER` "No longer a selector" — a
  migration note aimed at someone holding `=local`. Correct form. (The stale *code
  comments* in `lib/browser/` are now fixed.)
- `agent_tree.md` laws 2 and 3 and the tier/containment sections — rules stated once.
- `faq.md`'s objection-answering structure — genre-correct; an FAQ *is* answers to
  objections. Verified accurate throughout.
- `codex_protocol.md` `turn/failed` narrow phrasing and the dead notification cases —
  the latter explains four switch branches a reader would otherwise delete.
- `os_actions_reference.md` "There is no fallback tier", dialog deadline,
  `uri_reference.md` non-dispatched sub-paths.
- `app_protocol_reference.md` `app.register()` migration note — live throw behind it.
- `search/AGENTS.md:14`, `devtools/AGENTS.md` live rules and hazards,
  `browser-user/HINT.md:12`, `process-explorer/SKILL.md:15`,
  `devtools/HINT.md:7`, `video-editor-lite/AGENTS.md`.
- `sqlite.md` JSON-in-`_data`, future-work list (verified absent from `app-db.ts`), and
  all its technical claims (WAL, pool limits) — accurate.
- `app-development.md`'s instructional sections — instructions, not rebuttals.
- `app-development.md` bundled-library list vs `BUNDLED_LIBRARIES` — exact match, zero
  drift both directions.
- `guides/hooks.md` — 0 negation hits, every claim verified. Clean.
- `yaar_ml_runtime.md` — 4 GB budget, 50 MB upload cap, `numThreads = 1`, CSP — all
  verified (the dead `tier1` framing is now removed).
- `packages/frontend/CLAUDE.md` — clean.
- `IframeRenderer.tsx:90` — the 44th `LAN` mention; names a real runtime condition.
- `multi_window_apps_proposal.md:263` commit `9b941ed3` — exists; the audit row claiming
  otherwise was the error.
