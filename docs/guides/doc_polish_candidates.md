# Doc polish candidates

Worklist produced by sweeping the repo with the method in
[`doc_polish_case.md`](./doc_polish_case.md). Not a finished plan — a list of every
suspicious item found, so none has to be re-found. Unordered; fix in whatever batches
group well.

**Type** — `wrong` states something the code does not do · `fiction` names a file/app/API
that does not exist · `phantom` argues with a removed or settled thing · `dup` same fact
restated across files · `gap` real surface undocumented · `drift` EN/KO mismatch ·
`fmt` broken markup, link, or anchor.

**Ev.** — `✓` means the claim was re-checked against source while building this list.
Unmarked rows are reported but unverified; check before acting.

---

## Detector gaps (read first — the ranking script misses these classes)

| Type | Item | Ev. |
|---|---|---|
| gap | `doc_polish_case.md:24` globs `find docs -name '*.md'`. The largest confirmed phantom cluster (`?? '0'`, 10 restatements) is entirely in `.ts` and scores zero | ✓ |
| gap | Positively-phrased phantoms score zero — `sqlite.md` restates one absence 6× as "Purely additive", "No conflict — parallel systems". Density: 1 hit / 527 lines | ✓ |
| gap | `docs/ko/*` scores 0.0 by construction; terms are English. Needs `더 이상`, `없습니다`, `제거`, `않습니다` | ✓ |
| gap | Checklist has no "confirm the absence is real" step. Several `there is no X` warnings are false (see `devtools/AGENTS.md:268`) | ✓ |
| gap | Doc frames phantoms as noise; they decay into `wrong`. `monitor-identity.test.ts:314-321` is a phantom that became a false present-tense claim citing 4 dead line refs | ✓ |
| — | Nit: the case table's `Total 43` reads repo-wide but is scope-of-commit; a 44th mention sits in `IframeRenderer.tsx:90` (correctly untouched) | ✓ |

---

## Root `CLAUDE.md`

| Line | Type | Item | Ev. |
|---|---|---|---|
| 21 | wrong | `make dev` → `localhost:5173`. Single-port since `dev.sh`; frontend has no Vite and no `dev` script | ✓ |
| 36 | fiction | `make frontend` — no such Makefile target | ✓ |
| 118 | fiction | `slides-lite` given as a bundled app example | ✓ |
| 179-184 | fiction | `lib/` lists `bundled-types/`, `compiler/`, `sandbox/` — none exist. `node:vm` is 0 hits repo-wide. Omits real `tunnel/`, `download/`, `ssrf.ts`, `image.ts` | ✓ |
| 195, 229 | wrong | App agent "keyed by `appId`", "reused across all windows of that app". Key is `monitorId::appId` (`agent-pool.ts:48`) — not shared across monitors | ✓ |
| 231 | wrong | "target app must have an open window". `resolveTarget` auto-launches one (`mcp/app-agent/index.ts:112`, its own docstring) | ✓ |
| 285 | fiction | `shims/` lists `yaar.ts`; it is the directory `shims/yaar/`. Omits `yaar-ml.ts`, `zod.ts`, `lodash.ts`, `pixi.ts`, `dompurify.ts` | ✓ |
| 237-264 | dup | Sub-agent design restated near-verbatim from `packages/server/CLAUDE.md:250-292`, incl. the containment triad | |
| 49-59 | dup | Env-var block ⊂ `packages/server/CLAUDE.md:66-78` | |
| 270-281 | dup | Bundled-library list ⊂ `packages/compiler/CLAUDE.md:261-269` | |
| 300-306 | dup | Solid.js gotchas ⊂ `packages/compiler/CLAUDE.md:183, 224` | |

## `packages/server/CLAUDE.md`

| Line | Type | Item | Ev. |
|---|---|---|---|
| 105 | fiction | `agents/session.ts` — file is `agent-session.ts` | ✓ |
| 108 | wrong | `profiles.ts` listed as a file; it is a directory (8 files) | ✓ |
| 172 | wrong | "`LiveSession` … 605 lines"; actual 648. Delete the count rather than chase it | ✓ |
| 125-129, 234-238 | gap | MCP map + Tools table omit `app-agent/` and `messaging/` (2 of 5 `CORE_SERVERS`); `external/` appears in no CLAUDE.md at all | |
| 117-124 | gap | `handlers/` omits `define-actions.ts`, `history.ts`, `http.ts`, `mcp-gateway.ts`, `storage-bytes.ts`, `apps/agents-resource.ts` (the last is discussed at :254, :290) | |
| 130-136 | gap | `features/` omits `agents/`, `market/`, `session/`, `skills/`, `user/` | |
| 141-144 | gap | `lib/` omits `tunnel/`, `download/`, `ssrf.ts`, `errors.ts`, `ids.ts`, `image.ts`, `open-url.ts`, `format-verb-log.ts` | |
| 13-64 | dup | 52 lines (16% of file) restating `scripts/run-unit-tests.ts:1-21` and `tests/loopback/harness/boot.ts:15-24`, same CI anecdote. Rule at :53 is live — keep it, drop the retelling | |

## `packages/compiler/CLAUDE.md`

| Line | Type | Item | Ev. |
|---|---|---|---|
| 69 | wrong | "3 plugins" — 4 are passed (`build-app.ts:51-55`). Contradicts this file's own L30 and L203-224 | |
| 70 | wrong | "8 iframe SDK scripts" — 9 injected (`compile.ts:85-93`); `ime-guard` missing from count and list | |
| 113 | fmt | Dead link `docs/proposals/app_protocol_manifest_proposal.md` | ✓ |
| 112 | fiction | `devtools/src/protocol.ts` (963 lines) — now the directory `src/protocol/` | ✓ |
| 46-62 | gap | Shims map omits `zod.ts`, `lodash.ts`, `pixi.ts` — all three described in this file's own prose at L280-281 | |
| 96-101 | phantom | "A third reader used to stand there". Trim to ~2 sentences; the `YAAR_NO_TYPESCRIPT=1` / embedded-`typescript` half is live and stays | |
| 236-242 | dup | `YaarAppRegistration` narrative duplicates `describe-library.ts:70-71`; keep the last sentence only | |

## `packages/shared/CLAUDE.md`

| Line | Type | Item | Ev. |
|---|---|---|---|
| 21 | gap | `iframe-scripts/` list omits `ime-guard.ts`, `console-capture.ts`, `prelude.ts` | |

`packages/frontend/CLAUDE.md` — checked, clean.

---

## `apps/` prompt files

| Location | Type | Item | Ev. |
|---|---|---|---|
| `self-inspection/SKILL.md:11-14` | fiction | Instructs `invoke('yaar://config/settings', { verbMode: true })`. `verbMode` is 0 hits repo-wide — writes a junk key into real user settings before any check runs | ✓ |
| `self-inspection/SKILL.md:42` | wrong | "all 6 URI namespaces (apps, storage, windows, config, browser, sessions)". Real: 7 — apps, storage, windows, config, session, user, history. No `browser`, no `sessions`. Stated PASS criterion unreachable | ✓ |
| `self-inspection/SKILL.md:1-3` | phantom | Framed as the "(Verb Mode)" variant of a sibling app that does not exist | |
| `self-inspection/SKILL.md:383` | fiction | Report template asserts PASS for Excel/Word apps and `setCells`/`clearRange`/`excel import`. None exist | |
| `self-inspection/SKILL.md:188, 215, 308, 309` | fiction | Checks #8/#9/#13 target `slides-lite` and `image-viewer` — neither installed | ✓ |
| `devtools/AGENTS.md:268` | wrong | "There is no `yaar://session/` … and `yaar://` itself is not listable". Both false: registered at `handlers/session.ts:77`; `yaar://` has `verbs:['describe','read','list']` + real `list()`. True fact is narrower — those are `session-principal`, so 403 | ✓ |
| `devtools/AGENTS.md:8, 20, 22, 294`; `devtools/SKILL.md:12, 14` | wrong | Three incompatible shapes for one arg slot. Schema is flat `{command, params?, appId?, timeoutMs?}`; `:20` puts `{timeoutMs}` where `appId` goes; `:294` puts a string. The positional shorthand at `:8` is itself fiction | ✓ |
| `devtools/AGENTS.md:59` | phantom | Rebuts a `manifest` description that has already been rewritten; same fact stated correctly at `:248`. Both `no longer` hits in the file are this one sentence | |
| `devtools/AGENTS.md:214` | fiction | `apps/recent-papers/src/schema.ts` — absent from the repo | ✓ |
| `devtools/AGENTS.md:73` | gap | "All app metadata lives in `app.json`" list omits `personas`/`subagents` and `streams`. devtools authors other apps' manifests | |
| `devtools/AGENTS.md:263-264` | wrong | Offers `yaar://config/` and `yaar://history/` rows; devtools holds neither permission — both 403 per this file's own `:256` rule | |
| `devtools/AGENTS.md:283` | wrong | "Empty `html` template literals crash" — now a build error (`guards/solid-html-guard.ts`), not a runtime hunt | |
| `browser/AGENTS.md:13-77` | dup | 65 lines restating 3 state keys + 18 commands that `app-agent.ts:185-205` already appends as typed signatures every turn. Accurate today, one deploy from wrong. Keep the `press` key list, click-by-text idiom, mobile emulation | |
| `browser/AGENTS.md:153` | phantom | "DCInside does not accept api approach now" — orphaned debugging fragment | |
| `session-logs/AGENTS.md:9-30` | dup | Two manifest-duplicating tables. Keep `## Message Structure` (:36-51) | |
| `dock/SKILL.md:8`, `browser/SKILL.md:8` | wrong | `create({ uri: "dock", ... })` — no bare `create` tool is registered. Five sibling SKILLs already use the `invoke('yaar://windows/{id}', {action:'create'})` form | |
| 6 files | gap | `configurations`, `dock`, `market-apps`, `storage`, `session-logs`, `video-editor-lite` SKILL.md are generator boilerplate ("A compiled TypeScript application.") — content-free tokens on every read | |

---

## `docs/architecture/` + `docs/faq.md` + `docs/proposals/`

| Location | Type | Item | Ev. |
|---|---|---|---|
| `design_system.md:69-82` | fiction | Exception registry — an *enforcement* mechanism — grants deviations to `dc-comics`, `slides-lite`, `curious-library-vn`. None exist; none appear anywhere in git history. `curious-library-vn`'s only reference in the entire repo is that line | ✓ |
| `design_system.md:73` | wrong | Claims slides-lite "opts into `.y-light`"; `y-light` is 0 hits across `apps/*/src` | ✓ |
| `design_system.md:81` | wrong | Self-check greps `user-apps/*/src`, which does not exist in a clean checkout — errors on half its input as written | |
| `monitor_and_windows_guide.md:62-64` | wrong | Heading "There is no monitor fallback" + "**Nothing defaults to `'0'`**". `DEFAULT_MONITOR_ID` is live in ≥9 sites (`window-state.ts:261`, `windowsSlice.ts:108`, `monitorSlice.ts`, 6 default params in `agent-pool.ts`/`monitor-task-processor.ts`). The scoped clause after the colon is true — only the headline is false | ✓ |
| `agent_tree.md:91` | wrong | "*Arbitrary tool lists at spawn* … **Rejected permanently, not deferred**" — the shipped API accepts `tools` at spawn (`SubAgentToolSpec`, `MAX_SUB_AGENT_TOOLS = 12`), forcing the retraction at `:110`. Reword to "caller-chosen YAAR tools" | |
| `agent_tree.md:106-117` | phantom | 12 lines (8.5% of doc) restating laws 2-3 a 3rd/4th/5th time. Keep only the escalation path. Laws themselves stay — the case study names them as keepers | |
| `common_flow.md:105`, `os_architecture.md:61` | dup | Containment triad verbatim in 4 places + 3 paraphrases. Canonical home: `agent_tree.md` + `profiles/sub-agent.ts`. Both already link out | |
| `os_architecture.md:191` | wrong | Repeats the dead `"appProtocol": true` opt-in | |
| `faq.md:27`, `ko/faq.md:27` | fmt | `---### Why build a whole "OS"…` on one line — CommonMark renders it as literal text; section vanishes from the ToC. Both languages | ✓ |
| `README.md:78`, `verbalized-with-uri.md:15`, `faq.md:72` | dup | "~8K tokens" asserted 3× (4 with KO), pinned by no test; the tool-explosion rebuttal 3× incl. in a paragraph that already links out | |
| `multi_window_apps_proposal.md:53-66` | wrong | States the prerequisite as open ("unreachable in practice"; "`handleAction` overwrites the first window's state"). `allocateWindowId` fixed it (`features/window/create.ts:137`, `helpers.ts:39-46`), pinned by `window-create-collision.test.ts` | ✓ |
| `multi_window_apps_proposal.md:57` | fiction | Cites `features/dev/helpers.ts:52` for the launch snippet; that file is 32 lines and never held window code. Real source `agents/profiles/shared-sections.ts:66` | |
| `multi_window_apps_proposal.md:263` | fiction | Cites commit `9b941ed3` — not in this repo | |
| `os_presence_bridge_proposal.md` | gap | No `Status:` header (sibling has one). 0% shipped — `MprisWatcher`, `mpris`, `yaar://browser/presence` all 0 hits | |
| `os_presence_bridge_proposal.md:99` | gap | Attributes "widen it by extraction, never by exception" to established precedent; phrase appears nowhere else | |

---

## `docs/guides/`

| Location | Type | Item | Ev. |
|---|---|---|---|
| `app-development.md:1061`, `ko:922` | wrong | "`readBlob()` on a PDF returns the first page rendered as PNG". `readBlob(path)` takes no options, so `pdfPages` can never fire; the default branch returns the ASCII string `PDF document with N page(s), N bytes.` Cited file `handlers/apps.ts` is a 9-line re-export barrel with no PDF logic | ✓ |
| `app-development.md:697`, `ko:641` | fiction | `apps/music-maker` as an `appId` example. Real second case is `apps/mcp-manager` | ✓ |
| `app-development.md:694-697` | phantom | "Ignored fields seen in the wild" — `capture` is 0 hits across `apps/`, parsed by nothing. Doc corrects its own draft in the reader's face ("14, not the 19 once reported here") while `ko:640` still prints `19개`. Redundant with the live rule at :668 | |
| `app-development.md:410, 485, 560, 696` | phantom | "N apps invented this independently" census ×4. Verified all four counts now describe nothing: `let gen = 0` 0 hits, `FORBID_TAGS` in apps 0 hits, `invoke('yaar://http'` 0 hits, `capture` 0 hits. **Keep the rules; strike the headcounts** | |
| `app-development.md:378` | phantom | "snippet, not a component … the SDK never ships `solid-js/html` templates" — defends against an `<AppBar />` that never existed. Keep the actionable half | |
| `app-development.md:594` | phantom | "not `@bundled/dompurify` directly, **which no app imports any more**" — cut the clause | |
| `app-development.md:596` | dup | 4th statement of the sanitizer rule, list drifted from `:494` (adds `style`). Reduce to a pointer | |
| `app-development.md:995, 1007` | wrong | `app_query` param given as `key`; real param is `stateKey` (`handlers/window.ts:182`) | ✓ |
| `yaar_ml_runtime.md:12-14`, `ko:12-14` | fiction | Positions the doc against `tier1_inbrowser_models_plan.md` — never existed in any commit. Only broken relative link in the territory, in both languages | ✓ |
| `sqlite.md` | — | Genre misfiling: `## Motivation`, `## Design Decisions`, `## Implementation Status`, `## Risks & Mitigations`, `← NEW:` annotations — a landed RFC filed under how-to. Cited as "design:" by `app-development.md:1221`. Moving it to `proposals/` resolves most of the below without a rewrite | |
| `sqlite.md:65, 417, 428, 440, 483` + `app-development.md:1223` | phantom | "appDb does not replace appStorage" 6× — "Purely additive", "No conflict — parallel systems", "No migration needed". Audience was a reviewer who approved long ago | |
| `sqlite.md:346, 459`, `ko:347, 460` | fiction | `packages/compiler/src/shims/yaar.ts` — now a directory. Same stale path in root `CLAUDE.md` | ✓ |

---

## `docs/reference/`

Phantom yield here: **zero** — no absence is asserted twice in 2,686 lines. All findings are accuracy.

| Location | Type | Item | Ev. |
|---|---|---|---|
| `uri_reference.md:139` | fiction | `yaar://session/logs`. The string occurs exactly once in the whole repo — on that line. No handler; returns `No handler registered`. Real surface is `yaar://history/` | ✓ |
| `uri_reference.md:290-291` | wrong | Both window-create examples pass `create({ uri: ... })`. Never read — `handleCreate` uses `deriveWindowId`; absent from `invokeSchema` and `WindowCreateAction`. Silent wrong id | ✓ |
| `uri_reference.md:369` | wrong | "Apps with no `permissions` field get zero verb access by default." `SELF_GRANTS` auto-appends `apps/self/{storage,db,agents}/`, and `describe` skips the check entirely (`http/access.ts:250`). Understates access — the dangerous direction | |
| `uri_reference.md:32` | wrong | "`yaar://apps/self/` namespace itself is auto-granted" — three subtrees are; the app resource is not | |
| `uri_reference.md:96` | gap | 5 window actions documented; `handlers/window.ts:83-135` defines 16. Undocumented anywhere: `lock`, `unlock`, `move`, `resize`, `app_eval`, `protocol_log`, `app_subscribe`, `app_unsubscribe` | |
| `uri_reference.md` | gap | `yaar://config/mcp[/*]` absent from the Config table despite being registered and self-advertised by `read('yaar://config/')` | |
| `uri_reference.md:223-229` | gap | `read` documented as `{uri}`; takes six params incl. the whole PDF contract (`lines, pattern, context, pdfText, pdfPages`) | |
| `uri_reference.md` | gap | Brace expansion undocumented — all five verbs run `expandBraceUri` and fan out in parallel; every tool description advertises it | |
| `uri_reference.md:383-391` | gap | iframe SDK table omits `stream()` and `fetch()`; `stream` is what this doc's own sub-agent section depends on at :78-83 | |
| `app_protocol_reference.md:20, 409` | fiction | `"appProtocol": true` opt-in. Never parsed, declared by 0 apps, stripped by `deploy.ts:420` as legacy. Real opt-in is `defineApp()` | ✓ |
| `app_protocol_reference.md:29, 48` | wrong | Says `controls` lives in the *target's* `app.json`. Read from the *caller's* (`getAppMeta(ownAppId)`); the error text itself says so. Sends readers to edit the wrong file | ✓ |
| `app_protocol_reference.md:452-455` | wrong | Command Replay stale ×3: `replay:'never'` skipping, `replayed:true`/`ctx.replayed`, and `reannounce` never replaying | |
| `app_protocol_reference.md:436` | wrong | `emitAppProtocolRequest` documented as returning `undefined` on timeout; returns `PendingOutcome` discriminated union. 5000 ms default is correct | |
| `app_protocol_reference.md:84-107` | gap | Manifest interfaces omit `keybindings` and `replay` — two whole features, both extracted into `protocol.json` | |
| `storage_api_reference.md:231` | wrong | Documents DELETE 404; `errorResponse` defaults to 500. GET does 404 correctly in the same file | |
| `storage_api_reference.md:421-429` | wrong | The `appStorage` table describes `storage`. Real `appStorage` has `trySave`, `readJson`, `readJsonOr`, `readBinary`, `readBlob` — none documented — and `list` returns a different shape | |
| `storage_api_reference.md:443-455` | gap | `Settings` omits `remote: boolean` (in `DEFAULTS`, read at boot) | |
| `claude_codex.md:259-272` | fiction | Stream-mapping table cites `partial_message`, `message/delta`, `agent/thinking` — **0 hits each** repo-wide. Real path is `stream_event` → `content_block_delta` with `text_delta`/`thinking_delta`, never mentioned | ✓ |
| `claude_codex.md` vs `codex_protocol.md:174` | wrong | Two reference docs contradict each other on `turn/failed`. `codex_protocol.md` is right — absent from the generated union, no mapper case. Keep its narrow phrasing; it is exact | |
| `claude_codex.md:280` | wrong | "No auto-retry" for Claude — three retry paths exist (`session-provider.ts:286-294, 304-313, 429-437`). The claimed Claude/Codex asymmetry does not exist | |
| `codex_protocol.md:194` | wrong | Lists `item/commandExecution/outputDelta` under "Events We Skip"; actively handled at `message-mapper.ts:301` → `tool_output_delta`. Not in `IGNORED_METHODS` | |
| `codex_protocol.md` | gap | `thread/tokenUsage/updated` undocumented despite mapping to a distinct `usage` shape with cache-token subtraction. `IGNORED_METHODS` has 17 entries vs ~7 in the table | |
| `os_actions_reference.md` | gap | `window.close` is lock-protected (`windowsSlice.ts:152-158`) but documented as unprotected — silent rejection with no debugging pointer | |
| `os_actions_reference.md:195` | wrong | `window.capture` `requestId` marked optional; without it `store/desktop.ts:116-124` returns early — no capture, no warning. Optional in type, mandatory in practice | |
| `os_actions_reference.md:416-493` | wrong | "Required: yes" matches the TS types but not the validating schema — `components.ts:49-142` makes every field optional except `type`, so `{type:'button'}` parses at the MCP boundary | |
| `os_actions_reference.md` | gap | `appOrigin` on `window.create` undocumented in all of `docs/` — the proxy-port counterpart to `isolateOrigin` | |
| `openapi.yaml` | gap | 10 registered routes undocumented: `/api/sessions`, `/api/settings` GET+PATCH, `/api/domains` GET+PATCH, `/api/providers`, `/api/pick-directory`, `/api/remote-info`, `/api/agents/stats`, `/api/iframe-token`, `/api/shortcuts` GET+POST, `/api/dev/preview/{appId}`. 28 declared paths, none stale | |
| long tail | gap | Toast `duration` default 5000ms · `UserPromptInputField` type enum `text\|textarea\|password` · `UserPromptOption.description` · `cols` accepts coerced number + JSON string · `window.focus` "Panels are unaffected" half-true · `app_subscribe` `debounceMs` · command `timeoutMs` 1s floor · `configStatMtime` · MIME/upload source is `config/assets.ts` | |

Framing note: `os_actions_reference.md`'s source is **not** Zod — `packages/shared/src/actions.ts` has zero Zod imports. OS Actions are type-level only; just `components.ts`/`bridge.ts` validate at runtime.

---

## `docs/ko/` — translation drift

Root cause: seven EN commits never got a KO counterpart — `b93c96e`, `f867dad`, `bf0ec71`,
`4900fa6`, `b6ecef3`, `8db8aef` (app-development) and `8673cce` (remote_mode). The three
clean pairs are clean because every commit touching them touched both languages.

| Location | Type | Item | Ev. |
|---|---|---|---|
| `ko/app-development.md:405, 419-422` | wrong | **Teaches the opposite of the EN rule.** KO instructs `import DOMPurify from '@bundled/dompurify'` + `DOMPurify.sanitize(...)`; EN:494 forbids exactly this and EN:456 requires `sanitizeHtml` from `@bundled/yaar`. CI fails on it — `html-sanitization.test.ts:234` asserts `DIRECT_DOMPURIFY_FILES` is empty. `sanitizeHtml`: 5 occurrences EN, **0 KO** | ✓ |
| `ko/app-development.md` | drift | `## Sub-agents (Personas)` + 3 subsections (EN:1295-1414, 120 lines, 4 code blocks) absent. `personas`/`subagents`, `streamUri`, `reused:true`, `persona:*`, the 12-tool/6000-char limits, and the capability laws are undocumented in Korean | ✓ |
| `ko/app-development.md` | drift | `### Never trust a read either — validate at the boundary` (EN:1098-1159) absent — no `z.safeParse`, `z.looseObject`, `parsed.error.issues`, no "degraded-by-design must be distinguishable from broken" | |
| `ko/app-development.md:688-733` | drift | `defineApp()` 6-bullet API reference dropped (EN:786-822). `replay` (EN 8 / KO 0) and `keybindings`/`onShortcut` (EN 2 / KO 0) are 100% undocumented, incl. the combo grammar and reserved list. KO:709 sample omits `replay: 'never',` | |
| `ko/app-development.md` | drift | `createStaleGuard` absent (EN:406-427, EN 6 / KO 0). KO:963 import line silently drops it mid-block; `revive` lost from the `createPersistedSignal` paragraph (EN 3 / KO 0) | |
| `ko/app-development.md:610-642` | drift | `app.json` table missing 2 rows: `streams` and `personas`/`subagents` | |
| `ko/app-development.md:571, 792` | drift | Pre-`b93c96e` prompt-priority text; `buildProtocol(ctx)` where EN:913 says `registerProtocol(ctx)` | |
| `ko/app-development.md:640` | wrong | Prints `19개` — the number EN already retracted at :696 | |
| `ko/common_flow.md:15, 22` | wrong | Mermaid label `(one per appId)` vs EN `(one per monitor::app)`; "네 가지" (four) agent tiers vs EN "Five" | ✓ |
| `ko/common_flow.md` | drift | Missing `### 5. Sub-agent — the app's worker thread` (EN:95-121) and `### App state across app-agent handoffs` (EN:306-319) | |
| `ko/remote_mode.md` | drift | `### YAAR_REMOTE_TOKEN` never translated (EN:80-89). KO:73 omits "a fresh one per start … rescan the QR"; KO:78 omits `/health`'s `{status, remote}` | |

In sync, checked: `ko/faq.md` (except the shared `---###` fmt bug), `ko/hooks.md`,
`ko/sqlite.md`, `ko/yaar_ml_runtime.md`. The `5b2cf03` LAN cleanup is complete and correct
in Korean — `grep -ow LAN` = 1 each, no dead anchors, banner consistent. Do not redo it.

---

## Source comments and tests

### Cluster: the removed `?? '0'` monitor default

Confirmed gone from code — every surviving occurrence in the agents/session layer is
inside a comment. The only live `?? '0'` are unrelated `browserId` defaults and one test
harness param. In most cases the `throw` directly below already states the rule in its
error string.

| Location | Type | Item | Ev. |
|---|---|---|---|
| `agents/agent-context.ts:73-83` | phantom | 11-line block over a 9-line function | ✓ |
| `agents/monitor-task-processor.ts:16-25` | phantom | Same argument; throw below says "never from a default" | ✓ |
| `session/client-event-controller.ts:140-143` | phantom | Keep sentence 1 (the invariant), drop the rebuttal | ✓ |
| `agents/session-task-processor.ts:40-42` | phantom | Keep sentence 1 | ✓ |
| `agents/context-pool.ts:458-462`, `:477-482` | phantom | Same argument twice in one file. Mechanism survives in both | ✓ |
| `agents/agent-pool.ts:318-330` | phantom | Borderline — explains a real field (`sessionAgentMonitorId`); trim the `?? '0'` half only | |
| `tests/monitor-identity.test.ts:314-321` | wrong | Present tense, describes the *pre-fix* behavior, and all cited refs are dead: `context-pool.ts:447` is an `appId` lookup (real site `:466`), `monitor-task-processor.ts:24` is inside a comment | ✓ |
| `tests/monitor-identity.test.ts:393-399` | wrong | `findMonitorForAgent` cited at `agent-pool.ts:441`, actually `:986`; `handlers/window.ts:184` is `expression: {`; `activeMonitorId` was deleted — `monitor-registry.ts:4` says "There is deliberately no `activeMonitorId` here" | ✓ |
| `tests/monitor-identity.test.ts:371, 387` | phantom | Two more `?? '0'` retellings | ✓ |
| `packages/tests/src/integration/monitor-routing.test.ts:17` | phantom | `resolveWindowMonitor used to end ?? activeMonitorId ?? '0'` | ✓ |

### Cluster: the removed `PendingStore.defaultValue`

Canonical home to keep: `session/pending-store.ts:7-19`.

| Location | Type | Item | Ev. |
|---|---|---|---|
| `tests/deadline-semantics.test.ts:57-60` | dup | `:57` asserts `toEqual({ok:false, reason:'timeout'})`; `:60` re-asserts `ok===false`. Phantom sandwiched between. Delete 58-60 | ✓ |
| `tests/deadline-semantics.test.ts:95-96` | dup | Same pair inverted — delete `:95` | ✓ |
| `tests/deadline-semantics.test.ts:226-227` | phantom | "What is new is…" dates the comment to a commit | |
| `tests/action-emitter-app-protocol.test.ts:202-205` | phantom | Litigates a *previous version of this test file*. Test name + assertion already carry it. Pure deletion | |
| `session/action-emitter.ts:414` | phantom | Trailing clause "…not because false was lying around as a default" | |
| `session/action-emitter.ts:308` | phantom | "Both used to arrive here as `null`" — drop last sentence | |
| `tests/loopback/loopback-dead-client.test.ts:24-26` | phantom | Parenthetical, 8th telling. The three-claim structure above it stays | |

### Cluster: browser provider back-compat

| Location | Type | Item | Ev. |
|---|---|---|---|
| `lib/browser/local-user-browser.ts:70` | wrong | **User-facing error string**: "unset `YAAR_BROWSER_PROVIDER` to use the headless browser." `isForceHeadless()` tests `=== 'headless'` — unsetting does nothing. Following it literally leaves the user stuck | ✓ |
| `lib/browser/local-user-browser.ts:10-11` | wrong | "opt in with `YAAR_BROWSER_PROVIDER=local`" — nothing reads `'local'`. Directly contradicts `pool.ts:147` ("no longer a selector") in the same subsystem | ✓ |
| `lib/browser/pool.ts:155-164` | wrong | Names four "back-compat callers"; all four now call `getHeadlessBrowser()` directly. `getBrowserProvider()` has zero production callers | |
| `lib/browser/pool.ts:97-104` | wrong | "existing call sites and tests may still reference the old name" — zero call sites. `getBrowserPool()` has zero references anywhere | |
| `tests/browser-doors.test.ts:42-46` | phantom | Pins a removed selector value against a zero-caller deprecated function; repeats the false claim above | |

### Cluster: the removed `app.register()`

Guard is **live** (`iframe-scripts/app-protocol.ts:80-81` throws) — the rule stays. Stated 5×;
keep `extract-protocol-ast.ts:154-157` verbatim, reduce the rest to a pointer.

`extract-protocol-ast.ts:5-8` · `:614-617` · `extract-protocol-dir.ts:325-330` ·
`tests/extract-protocol-ast.test.ts:490-493`

### Other

| Location | Type | Item | Ev. |
|---|---|---|---|
| `packages/tests/src/security/html-sanitization.test.ts:235-238` | dup | Comment restates the test name + `DIRECT_DOMPURIFY_FILES`'s own doc. 3rd telling | |
| `.../html-sanitization.test.ts:242` | phantom | "The policy is no longer duplicated per app" — 4th telling. Rest of the comment is a live hazard, keep | |
| `providers/codex/provider.ts:419-423` | fmt | Two stacked JSDoc blocks — the first documents `ensureThread`, stranded 52 lines above it at `:475`, which is now undocumented | |
| `providers/codex/provider.ts:429-441` | dup | Two consecutive paragraphs opening on the identical premise. Security note (token vs id) is a keeper — merge the premises | |
| `apps/video-editor-lite/src/editor/prefs.ts:41-42` | phantom | "that is also what the hand-rolled `typeof` chain this replaced did" — isolated clause | |

---

## Checked and cleared — do not cut

Listed so they are not re-flagged. Each was a candidate; each survived verification.

- `session/action-emitter.ts:127-133` "A late reply used to be dropped in silence" — the
  case study's own named keeper; `loopback-late-reply.test.ts` pins the behavior it
  explains. Also `:135-140` (`expiredDialogs`) and `:145-159` (session-keyed
  `readyWindows`) — same class, each names a real shipped bug.
- `session/monitor-registry.ts:1-18` "There is deliberately no `activeMonitorId` here."
- `http/access.ts:105-121`, `http/auth.ts:63-70` and `:149-155` — live security shapes.
- `shims/yaar/define-app.ts:340-348` "Please do not 'simplify' `typeof document` away."
- `tests/security/html-sanitization.test.ts:18-28` (jsdom vs happy-dom) and `:181-186`
  (why the roster is scanned, not listed).
- `config/env.ts:189-215` — live operational constraint with an action.
- `packages/server/CLAUDE.md` sub-agent `never`s (~8) — eight *different* mechanisms in
  eight files, not one argument restated.
- `packages/server/CLAUDE.md:77` `YAAR_BROWSER_PROVIDER` "No longer a selector" — a
  migration note aimed at someone holding `=local`. Correct form. (The *code comment* is
  the stale one — see above.)
- `agent_tree.md:54-59, 61-67` (laws 2 and 3), `:79-88`, `:93-104` — rules stated once.
- `faq.md`'s objection-answering structure — genre-correct; an FAQ *is* answers to
  objections. Verified accurate throughout.
- `codex_protocol.md:174` (`turn/failed`), `:197-206` (dead notification cases) — the
  latter explains four switch branches a reader would otherwise delete.
- `os_actions_reference.md:197` "There is no fallback tier", `:293` dialog deadline,
  `uri_reference.md:105` non-dispatched sub-paths.
- `app_protocol_reference.md:306` `app.register()` migration note — live throw behind it.
- `search/AGENTS.md:14`, `devtools/AGENTS.md:13, 75, 107, 146-181, 183-215, 228, 248`,
  `browser-user/HINT.md:12`, `chitchats/SKILL.md`, `process-explorer/SKILL.md:15`,
  `devtools/HINT.md:7`, `video-editor-lite/AGENTS.md` — live rules and hazards.
- `sqlite.md:142` (JSON in `_data`), `:465-470` (future work — verified absent from
  `app-db.ts`), and all its technical claims (WAL, pool limits) — accurate.
- `app-development.md:378`(actionable half), `:500-518`, `:668`, `:820-826`, `:903-908`,
  `:955-959`, `:1063-1158`, `:1302`, `:1341-1352` — instructions, not rebuttals.
- `app-development.md` bundled-library list vs `BUNDLED_LIBRARIES` — exact match, zero
  drift both directions.
- `guides/hooks.md` — 0 negation hits, every claim verified. Clean.
- `yaar_ml_runtime.md` everything except `:12-14` — 4 GB budget, 50 MB upload cap,
  `numThreads = 1`, CSP — all verified.
- `packages/frontend/CLAUDE.md` — clean.
- `IframeRenderer.tsx:90` — the 44th `LAN` mention; names a real runtime condition.
