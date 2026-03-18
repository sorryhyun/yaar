# Plan: Deprecate `yaar://sandbox` — Migrate to Devtools App

## Goal

Remove the `yaar://sandbox/*` URI namespace in favor of the **devtools app** as the single entry point for app development. The AI agent should use the devtools app (via app protocol commands) instead of raw sandbox verbs.

## What Gets Removed

### Files to delete

| File | Lines | What it does |
|------|-------|-------------|
| `packages/server/src/handlers/sandbox.ts` | 249 | URI handler for `yaar://sandbox/*` and `yaar://sandbox/eval` |
| `packages/server/src/features/sandbox/files.ts` | 160 | File read/write/edit/delete for sandbox dir |
| `packages/server/src/features/sandbox/eval.ts` | 47 | `formatSandboxResult()` for eval output |

### Files to modify

| File | Change |
|------|--------|
| `packages/server/src/handlers/index.ts` | Remove `registerSandboxHandlers()` call |
| `packages/server/src/agents/profiles/shared-sections.ts` | Remove `SANDBOX_SECTION` export |
| `packages/server/src/agents/profiles/code.ts` | Remove sandbox eval references (if any) |
| `packages/server/src/features/config/hooks.ts` | Remove `yaar://sandbox/*` pattern matching |
| `packages/server/src/features/window/resolve-window.ts` | Remove sandbox URI content resolution |
| `packages/server/src/http/routes/files.ts` | Remove `GET /api/sandbox/{id}/{path}` route |
| `packages/server/src/tests/hooks.test.ts` | Update sandbox URI test patterns |
| `packages/server/src/handlers/session.ts` | Remove sandbox references |

### What stays

| Component | Reason |
|-----------|--------|
| `lib/compiler/` | Still used by `/api/dev/compile` (devtools REST route) |
| `lib/sandbox/` (vm execution) | Still used by `code` profile for JS eval |
| `features/dev/compile.ts` | Called by devtools REST API |
| `features/dev/deploy.ts` | Called by devtools REST API |
| `features/dev/clone.ts` | Called by devtools REST API |
| `features/dev/helpers.ts` | Used by deploy |
| `http/routes/dev.ts` | Devtools REST endpoints (`/api/dev/*`) |
| `apps/devtools/` | The replacement — stays and gets enhanced |

## Migration Steps

### Phase 2: Remove sandbox URI handler

1. **Delete `handlers/sandbox.ts`** and remove `registerSandboxHandlers()` from `handlers/index.ts`.
2. **Delete `features/sandbox/files.ts`** — no longer needed (devtools uses `/api/dev/*` routes).
3. **Update `features/window/resolve-window.ts`** — remove sandbox content URI resolution.
4. **Update `http/routes/files.ts`** — remove `/api/sandbox/*` file serving route.
5. **Update `features/config/hooks.ts`** — remove sandbox URI pattern matching.

### Phase 3: Decide on `yaar://sandbox/eval`

The eval feature (`executeCode` in `lib/sandbox/`) is used by the `code` profile for computation tasks, separate from app dev. Options:

- **Option A: Move to `yaar://code/eval`** — Register under a new URI that matches the code profile's domain. Clean separation.
- **Option B: Keep `yaar://eval`** — Simpler, standalone. Register as a top-level URI.
- **Option C: Inline into code profile** — Make eval a direct tool instead of a verb. Less flexible but simpler.

Recommendation: **Option A** (`yaar://code/eval`). It's already semantically part of the code profile.

### Phase 4: Clean up references

1. Remove `SANDBOX_SECTION` from `shared-sections.ts`.
2. Update all agent prompts that mention sandbox URIs.
3. Update `handlers/session.ts` if it references sandbox.
4. Update tests in `hooks.test.ts`.
5. Delete `sandbox/` directory contents (git-ignored, but clean up).
6. Update root `CLAUDE.md` monorepo structure diagram.
7. Update `packages/server/CLAUDE.md` directory structure.

### Phase 5: Enhance devtools app (if needed)

Things the sandbox handler could do that devtools should also support:

- [ ] **Delete file** — verify devtools supports this via command
- [ ] **List files** — verify devtools exposes file listing via query
- [ ] **Read file with line numbers** — verify devtools `query("openFile")` returns content

Audit the devtools AGENT.md commands against the sandbox handler's full verb set to ensure no capability gaps.

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Agent prompts reference `yaar://sandbox/*` | Grep all profiles and skills, update references |
| Existing sandbox dirs in `sandbox/` | Git-ignored, won't affect repo. Users lose in-progress sandboxes (acceptable — they're ephemeral) |
| `lib/sandbox/` confused with `handlers/sandbox.ts` | `lib/sandbox/` is the vm execution engine (stays). `handlers/sandbox.ts` is the URI handler (removed). Names are confusing but separate concerns |
| Devtools app protocol coverage gaps | Audit before removing sandbox handler |

## Non-Goals

- Renaming `lib/sandbox/` (vm execution runtime) — it's correctly named for what it does
- Changing `lib/compiler/` — it's provider-agnostic, used by both old and new paths
- Modifying `/api/dev/*` REST routes — they're the devtools backend
- Removing `features/dev/` — it's the shared business logic layer
