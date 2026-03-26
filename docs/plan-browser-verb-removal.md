# Plan: Remove `yaar://browser` Verb & Web Subagent

## Motivation

The browser app is passive — it displays CDP output but has no meaningful app agent interaction. Having `yaar://browser` in the verb surface causes the orchestrator (monitor agent) to sometimes try talking to the browser app agent, which doesn't make sense since browser actions are only runnable via verbs/HTTP, not through the app.

The `web` subagent profile bundles browser automation, HTTP, and web search into a single delegated agent. With the browser verb removed, the web profile loses its primary differentiator. HTTP fetch is already available as a verb (`yaar://http/`), and the browser app agent (with richer HINT.md/AGENTS.md) can handle sustained browsing tasks better than a generic subagent.

## Decision: Remove Web Subagent, Empower Browser App Agent

- **Browser tasks** → orchestrator opens browser app, delegates via app agent protocol. Browser app agent drives CDP autonomously and reports back.
- **HTTP/fetch** → orchestrator uses `invoke('yaar://http/...')` directly (already works).
- **WebSearch tool** → removed from orchestrator. HTTP fetch verb covers web data needs.
- **Web subagent** → removed entirely. No subagent profiles remain.

## Current References to Remove

| What | Where | Action |
|------|-------|--------|
| `yaar://browser` verb handler | `handlers/browser.ts` | Delete file |
| Verb registration call | `handlers/index.ts` | Remove `registerBrowserHandlers()` |
| `BROWSER_SECTION` prompt | `profiles/shared-sections.ts` | Delete section |
| `BROWSER_SECTION` in orchestrator | `profiles/orchestrator.ts` | Remove import + interpolation |
| `BROWSER_SECTION` in web profile | `profiles/web.ts` | Delete entire file |
| `web` profile registry | `profiles/index.ts` | Remove from `profiles` map, `buildAgentDefinitions()`, `getProfile()` fallback |
| `URI_NAMESPACES_TABLE` row | `profiles/shared-sections.ts` | Remove `yaar://browser/` row |
| `WebSearch` in orchestrator tools | `profiles/index.ts` (`DEVELOPER_PROFILE`) | Remove from `allowedTools` |
| `Agent` (subagent) in orchestrator tools | `profiles/index.ts` (`DEVELOPER_PROFILE`) | Remove from `allowedTools` |
| Orchestrator subagent instructions | `profiles/orchestrator.ts` | Remove "Delegate via Agent Tool" section |
| `yaar://browser/` in session capabilities | `handlers/session.ts` | Remove from capability list |
| Legacy browser routes in `files.ts` | `http/routes/files.ts` | Remove duplicate `/api/browser/*` routes |
| `yaar://browser/` permission | `apps/thesingularity-reader/app.json` | Migrate to `yaar-web` SDK or remove |
| `yaar://browser/` in devtools docs | `apps/devtools/AGENTS.md` | Remove reference |
| Browser app `HINT.md` | `apps/browser/HINT.md` | Rewrite: orchestrator delegates browsing tasks to browser app agent |
| Browser app `SKILL.md` | `apps/browser/SKILL.md` | Rewrite: browser app is an active agent, not passive display |
| Browser app `AGENTS.md` | `apps/browser/AGENTS.md` | Enrich: add autonomous browsing patterns, richer action vocabulary |
| CLAUDE.md files | `packages/server/CLAUDE.md`, root | Update verb namespace tables, handler references |

## Steps

### 1. Remove verb layer

- Delete `handlers/browser.ts`
- Remove `registerBrowserHandlers()` call from `handlers/index.ts`
- Remove `yaar://browser/` from session capabilities in `handlers/session.ts`

### ~~2. Remove web subagent profile~~ DONE

- ~~Delete `profiles/web.ts`~~
- ~~Remove `web` from `profiles` map, `WEB_PROFILE` re-exports, `getProfile()`, `buildAgentDefinitions()` from `profiles/index.ts`~~
- ~~Remove `buildAgentDefinitions` import + `agents` field from `session-provider.ts`~~
- ~~Clean up test mocks in `multi-monitor.test.ts`~~

### ~~3. Strip orchestrator of subagent/browser/websearch~~ DONE

- ~~Remove `BROWSER_SECTION` import + interpolation from `profiles/orchestrator.ts`~~
- ~~Remove "Delegate via Agent Tool" section — orchestrator acts directly or uses apps~~
- ~~Remove `WebSearch` and `Task` from `DEVELOPER_PROFILE.allowedTools`~~
- ~~Delete `BROWSER_SECTION` from `profiles/shared-sections.ts`~~
- ~~Remove `yaar://browser/` row from `URI_NAMESPACES_TABLE`~~

### ~~4. Consolidate HTTP routes~~ DONE

- ~~Moved screenshot, SSE events, and navigate routes from `files.ts` into `routes/browser.ts`~~
- ~~Removed all browser routes from `files.ts`~~
- ~~Updated `PUBLIC_ENDPOINTS` in `browser.ts` to include moved routes~~
- ~~Navigate/screenshot/events routes kept unauthenticated (same-origin iframe access)~~

### 5. Enrich browser app agent

- Rewrite `apps/browser/HINT.md` — tell orchestrator to open browser app and delegate sustained browsing tasks
- Rewrite `apps/browser/SKILL.md` — describe browser app as an active autonomous agent
- Enrich `apps/browser/AGENTS.md` — add patterns for autonomous multi-step browsing, research, extraction

### 7. Update docs

- Server `CLAUDE.md` — update handler list, verb namespace table, REST API section
- Root `CLAUDE.md` — update if needed
- This plan doc — mark completed

## Open Questions

- Should the browser app `protocol.json` be expanded with richer commands for autonomous browsing patterns?
