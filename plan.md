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

Notes:
- `features/config/hooks.ts` — no sandbox-specific code (generic wildcard matching), left as-is
- `features/dev/compile.ts` — now orphaned (`doCompile`/`doTypecheck` were only imported by the deleted handler; devtools REST routes import from `lib/compiler/` directly). Can be cleaned up in Phase 4.

## Remaining Phases

### Phase 3: Decide on `yaar://sandbox/eval`

The eval feature (`executeCode` in `lib/sandbox/`) is used by the `code` profile for computation tasks, separate from app dev. Options:

- **Option A: Move to `yaar://code/eval`** — Register under a new URI that matches the code profile's domain. Clean separation.
- **Option B: Keep `yaar://eval`** — Simpler, standalone. Register as a top-level URI.
- **Option C: Inline into code profile** — Make eval a direct tool instead of a verb. Less flexible but simpler.

Recommendation: **Option A** (`yaar://code/eval`). It's already semantically part of the code profile.

`features/sandbox/eval.ts` still exists (only file left in `features/sandbox/`). Move or inline it as part of this phase.

### Phase 4: Clean up references

1. Remove `SANDBOX_SECTION` from `shared-sections.ts`.
2. Update all agent prompts that mention sandbox URIs.
3. Delete orphaned `features/dev/compile.ts` (`doCompile`/`doTypecheck`).
4. Update tests in `hooks.test.ts` if any reference sandbox URIs.
5. Delete `sandbox/` directory contents (git-ignored, but clean up).
6. Update `docs/` sandbox references (11 files — see list below).

Docs with sandbox references:
- `docs/common_flow.md`, `docs/ko/common_flow.md`
- `docs/app-development.md`, `docs/ko/app-development.md`
- `docs/os_architecture.md`
- `docs/takeaways.md`
- `docs/verbalized-with-uri.md`
- `docs/hooks.md`
- `docs/os_actions_reference.md`
- `docs/storage_api_reference.md`
- `docs/codex_protocol.md`

### Phase 5: Enhance devtools app (if needed)

Things the sandbox handler could do that devtools should also support:

- [ ] **Delete file** — verify devtools supports this via command
- [ ] **List files** — verify devtools exposes file listing via query
- [ ] **Read file with line numbers** — verify devtools `query("openFile")` returns content

Audit the devtools AGENTS.md commands against the sandbox handler's full verb set to ensure no capability gaps.

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Agent prompts reference `yaar://sandbox/*` | Grep all profiles and skills, update references |
| Existing sandbox dirs in `sandbox/` | Git-ignored, won't affect repo. Users lose in-progress sandboxes (acceptable — they're ephemeral) |
| `lib/sandbox/` confused with deleted handler | `lib/sandbox/` is the vm execution engine (stays). The URI handler is removed. |
| Devtools app protocol coverage gaps | Audit before removing sandbox handler |

## Non-Goals

- Renaming `lib/sandbox/` (vm execution runtime) — it's correctly named for what it does
- Changing `lib/compiler/` — it's provider-agnostic, used by both old and new paths
- Modifying `/api/dev/*` REST routes — they're the devtools backend
