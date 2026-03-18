# Plan: Deprecate `yaar://sandbox` — Migrate to Devtools App

## Goal

Remove the `yaar://sandbox/*` URI namespace in favor of the **devtools app** as the single entry point for app development. The AI agent should use the devtools app (via app protocol commands) instead of raw sandbox verbs.

## Completed

### Phase 2: Remove sandbox URI handler ✅

Deleted:
- `packages/server/src/handlers/sandbox.ts` — URI handler for `yaar://sandbox/*` and `yaar://sandbox/eval`
- `packages/server/src/features/sandbox/files.ts` — sandbox file read/write/edit/delete

Modified:
- `packages/server/src/handlers/index.ts` — removed `registerSandboxHandlers()` import and call
- `packages/server/src/handlers/uri-resolve.ts` — removed `sandbox` from `ResourceKind`, `sandboxId` field, sandbox case, bare URI regex
- `packages/server/src/handlers/session.ts` — removed `yaar://sandbox/` from namespace listing
- `packages/server/src/http/routes/files.ts` — removed `/api/sandbox/*` endpoint, `handleSandbox()`, switch case
- `packages/server/src/features/window/resolve-window.ts` — removed sandbox mention from comment
- `packages/shared/src/yaar-uri.ts` — removed `sandbox` from `YaarAuthority`, `YAAR_RE`, `resolveContentUri`, `ParsedContentPath`, `ParsedFileUri`, `parseFileUri`, `parseContentPath`, `buildFileUri`

### Phase 3: Remove sandbox eval ✅

Decision: Remove entirely — code execution needs should use the devtools app.

Deleted:
- `packages/server/src/features/sandbox/eval.ts` — SANDBOX_HINTS and formatSandboxResult
- `packages/server/src/features/sandbox/` — directory removed (was the last file)

### Phase 4: Clean up references ✅

Deleted:
- `packages/server/src/features/dev/compile.ts` — orphaned `doCompile`/`doTypecheck` (devtools routes import from `lib/compiler/` directly)

Modified:
- `packages/server/src/agents/profiles/shared-sections.ts` — removed `SANDBOX_SECTION` export
- `packages/server/src/agents/profiles/code.ts` — rewrote profile: removed sandbox workflow, added devtools app guidance
- `packages/server/src/agents/profiles/orchestrator.ts` — updated code profile description
- `packages/server/src/http/routes/files.ts` — removed "sandbox" from file comment
- `packages/server/src/features/dev/helpers.ts` — updated SKILL.md template to reference devtools instead of sandbox clone URI
- `packages/server/src/features/config/hooks.ts` — updated doc comments to use `yaar://storage/*` examples
- `packages/server/src/tests/hooks.test.ts` — replaced `yaar://sandbox/*` test URIs with `yaar://storage/*`

Docs updated (sandbox references removed/replaced):
- `docs/common_flow.md`, `docs/ko/common_flow.md`
- `docs/app-development.md`, `docs/ko/app-development.md`
- `docs/os_architecture.md`
- `docs/verbalized-with-uri.md`
- `docs/hooks.md`, `docs/example_hooks.json`
- `docs/storage_api_reference.md`

## Remaining

### Phase 5: Enhance devtools app (if needed)

Things the sandbox handler could do that devtools should also support:

- [ ] **Delete file** — verify devtools supports this via command
- [ ] **List files** — verify devtools exposes file listing via query
- [ ] **Read file with line numbers** — verify devtools `query("openFile")` returns content

Audit the devtools AGENTS.md commands against the sandbox handler's full verb set to ensure no capability gaps.

## Non-Goals

- Renaming `lib/sandbox/` (vm execution runtime) — it's correctly named for what it does
- Changing `lib/compiler/` — it's provider-agnostic, used by both old and new paths
- Modifying `/api/dev/*` REST routes — they're the devtools backend
- Renaming `sandbox` terminology in `features/dev/deploy.ts` (internal dev workspace concept, still functional)
