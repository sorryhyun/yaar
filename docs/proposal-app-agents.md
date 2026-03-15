# Proposal: App Agents

## Problem

Window agents create unnecessary complexity and context disconnects:

1. **Context disconnect for plain windows**: When the user submits a form or clicks a button in a markdown/table/component window, a *window agent* handles it — separate from the main agent that created the window. The main agent has the full conversation context; the window agent starts fresh with only 5 recent turns. This disconnect is the root cause of many "the agent forgot what I asked" issues.

2. **Context bloat for app windows**: An app's window agent bootstraps with main conversation history and all verb tools across every `yaar://` namespace. A spreadsheet agent doesn't need `yaar://browser/*` or `yaar://sandbox/*`. Two discovery round-trips (read skill, query manifest) are burned before the agent can do real work.

3. **No app continuity**: Window agents are keyed by windowId. Close the window, lose the agent. Reopen the same app → fresh agent with no memory of prior interactions.

## Remaining Work

### Remove `WindowTaskProcessor` and `WindowConnectionPolicy`

Plain window interactions now route to the main agent, and app windows route to `AppTaskProcessor`. The old `WindowTaskProcessor` and `WindowConnectionPolicy` are still in the codebase but no longer used for new routing. They should be deleted once the non-app window close cleanup logic is migrated.

Files to delete:
- `packages/server/src/agents/window-task-processor.ts`
- `packages/server/src/agents/context-pool-policies/window-connection-policy.ts`

Files to update:
- `packages/server/src/agents/context-pool-policies/index.ts` — remove `WindowConnectionPolicy` export
- `packages/server/src/agents/context-pool.ts` — remove `windowProcessor` field and `WindowConnectionPolicy` usage
- `packages/server/src/agents/pool-types.ts` — remove `windowConnectionPolicy` from `PoolContext`
- `packages/server/src/agents/agent-pool.ts` — remove `windowAgents` map and related methods

### Remove window agent methods from AgentPool

- Remove `windowAgents` map, `getOrCreateWindowAgent`, `disposeWindowAgent`, `hasWindowAgent`
- Update `cleanup()`, `interruptAll()`, `getStats()` to remove window agent iterations

### Rename main → monitor (Separate PR)

With window agents removed, rename "main agent" to **monitor agent** for clarity:

| Agent type | Scoped to | Lifecycle |
|------------|-----------|-----------|
| **Monitor agent** | A monitor (virtual desktop) | Monitor lifetime |
| **App agent** | An app (by appId) | Session lifetime |

Rename surface:
- `MainTaskProcessor` → `MonitorTaskProcessor`
- `MainQueuePolicy` → `MonitorQueuePolicy`
- `MAIN_PROFILE` → `MONITOR_PROFILE`
- References in `ContextPool`, `AgentPool`, profiles, and docs
