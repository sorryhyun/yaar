# Suggestion: Consolidate Verb Handlers + URI into `src/handlers/`

## Problem

Verb handler files in `mcp/verbs/handlers/` have deep `../../../` imports to reach `features/`, `uri/`, and `mcp/` siblings. The 9 handler files + 3 URI files form a cohesive unit whose primary consumers are each other.

## Proposal

Create `src/handlers/` as the home for URI routing infrastructure and all verb handler registrations.

```
src/
├── handlers/                     # NEW — verb dispatch layer
│   ├── index.ts                  # initRegistry() + registerVerbTools() (from mcp/verbs/)
│   ├── uri/                      # Moved from src/uri/
│   │   ├── registry.ts           # ResourceRegistry, ResourceHandler, VerbResult
│   │   └── resolve.ts            # resolveUri(), ResolvedUri types
│   ├── apps.ts                   # Moved from mcp/verbs/handlers/
│   ├── basic.ts
│   ├── browser.ts
│   ├── config.ts
│   ├── session.ts
│   ├── user.ts
│   ├── window.ts
│   ├── agents.ts
│   └── skills.ts
├── features/                     # Unchanged — pure domain logic
├── mcp/
│   ├── server.ts                 # imports registerVerbTools from handlers/
│   ├── verbs/                    # REMOVED (absorbed into handlers/)
│   ├── legacy/                   # Unchanged
│   └── ...
```

## Import Path Improvements

| File | Before | After |
|------|--------|-------|
| `handlers/config.ts` → features | `../../../features/config/settings.js` | `../features/config/settings.js` |
| `handlers/config.ts` → uri | `../../../uri/registry.js` | `./uri/registry.js` |
| `handlers/window.ts` → features | `../../../features/window/manifest-utils.js` | `../features/window/manifest-utils.js` |
| `handlers/basic.ts` → features | `../../../features/dev/helpers.js` | `../features/dev/helpers.js` |
| `mcp/server.ts` → handlers | `./verbs/index.js` | `../handlers/index.js` |

Every handler import goes from 3-4 levels (`../../../`) to 1-2 levels (`../`).

## What Moves Where

### `src/uri/` → `src/handlers/uri/`

| File | Lines | Consumers |
|------|-------|-----------|
| `registry.ts` | 203 | 9 handlers, `tools.ts`, `index.ts`, 2 test files |
| `resolve.ts` | 243 | 9 handlers, `window/create.ts` (legacy), 10 test files |
| `index.ts` | 20 | barrel re-export (merge into new index) |

### `mcp/verbs/handlers/` → `src/handlers/`

| File | Lines | Feature imports |
|------|-------|----------------|
| `apps.ts` | 248 | `features/apps/discovery` |
| `basic.ts` | 637 | `features/dev/{helpers,compile,deploy}` |
| `browser.ts` | 327 | `features/browser/shared` |
| `config.ts` | 290 | `features/config/{settings,hooks-handler,shortcuts,mounts,app}`, `mcp/domains` |
| `session.ts` | 118 | none |
| `user.ts` | 152 | none |
| `window.ts` | 599 | `features/{apps/discovery,window/manifest-utils}` |
| `agents.ts` | 127 | none |
| `skills.ts` | 62 | lazy `mcp/skills/topics` |

### `mcp/verbs/tools.ts` + `mcp/verbs/index.ts` → `src/handlers/index.ts`

Merge the singleton registry init and MCP tool registration into one entry point.

## What Stays

- `mcp/server.ts` — orchestrates all MCP servers (just changes import path)
- `mcp/legacy/` — untouched (deprecated, will be removed)
- `mcp/verbs/` — **deleted** (fully absorbed)
- `features/` — untouched (pure domain logic, no dependency on handlers)

## Files Requiring Import Updates

16 source files + 10 test files:

**Source (16):**
- 9 handler files (internal `./uri/` imports)
- `mcp/server.ts` (import `registerVerbTools`)
- `mcp/legacy/window/create.ts` (imports `resolveResourceUri`)
- `agents/profiles.ts` (imports `VERB_TOOL_NAMES`)
- `mcp/index.ts` (re-exports)
- 3 files importing from `uri/index.ts`

**Tests (10):**
- `registry.test.ts`, `*-handlers.test.ts` (8), `monitor-resource.test.ts`

## Risks

- **Low**: No circular dependencies. All imports are one-way.
- **Low**: No runtime behavior changes — pure file moves + import rewrites.
- **Medium**: 26 files need import updates — straightforward but tedious. Typecheck will catch any missed paths.

## Non-Goals

- Not moving `features/` — it stays as pure domain logic with no MCP/handler awareness.
- Not adding path aliases — the 1-2 level imports are clear enough without `@server/` aliases.
- Not touching `mcp/legacy/` — deprecated and scheduled for removal.

## Alternative Considered

**Move handlers into `features/`** (e.g., `features/config/verb-handler.ts`): Co-locates handler with domain logic but couples `features/` to URI registry types. Rejected because `features/` currently has zero dependencies on MCP/URI infrastructure, and that's a good boundary to keep.
