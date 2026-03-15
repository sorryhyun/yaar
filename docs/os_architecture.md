# OS Architecture Map

YAAR maps directly to operating system concepts. This document makes that mapping explicit.

For runtime details, see the linked docs in each section. For the Session/Monitor/Window hierarchy, see [`monitor_and_windows_guide.md`](./monitor_and_windows_guide.md). For message flow diagrams, see [`common_flow.md`](./common_flow.md).

## Quick Reference

| OS Concept | YAAR Equivalent | URI Namespace | Key File(s) |
|---|---|---|---|
| Kernel | `LiveSession` + `ContextPool` | `yaar://sessions/current` | `session/live-session.ts`, `agents/context-pool.ts` |
| Process table | `AgentPool` | `yaar://agents/` | `agents/agent-pool.ts` |
| Process types | Main (init), app (daemon), ephemeral (one-shot) | `yaar://agents/{instanceId}` | `agents/profiles.ts` |
| Scheduler | `MainQueuePolicy`, `WindowQueuePolicy`, `MonitorBudgetPolicy` | — | `agents/context-pool-policies/` |
| Syscalls | 8 MCP tool namespaces | — | `mcp/server.ts` |
| Instruction set | System prompt (~108 lines) | — | `providers/claude/system-prompt.ts` |
| Boot | `initializeSubsystems()` | — | `lifecycle.ts` |
| Filesystem | `storage/` + mount system | `yaar://storage/` | `storage/storage-manager.ts`, `storage/mounts.ts` |
| Window manager | `WindowStateRegistry` | `yaar://monitors/` | `mcp/window-state.ts` |
| Display server | `BroadcastCenter` | — | `session/broadcast-center.ts` |
| IPC | `ActionEmitter`, `InteractionTimeline`, App Protocol | — | `mcp/action-emitter.ts`, `agents/interaction-timeline.ts` |
| Device drivers | `AITransport` implementations | — | `providers/types.ts`, `providers/claude/`, `providers/codex/` |
| Desktop environment | React frontend + Zustand store | — | `packages/frontend/` |
| Package manager | Apps marketplace | `yaar://apps/` | `mcp/apps/` |
| User interaction | Notifications, prompts, clipboard | `yaar://user/` | `mcp/user/` |
| Configuration | Settings, hooks, shortcuts, mounts | `yaar://config/` | `storage/settings.ts`, `mcp/system/` |

All paths are relative to `packages/server/src/` unless noted otherwise. All resources are addressable via the `yaar://` URI scheme — see [`verbalized-with-uri.md`](./verbalized-with-uri.md) for the full 9-namespace reference.

---

## Kernel

`LiveSession` is the kernel. One instance per session, owned by the singleton `SessionHub`.

It owns the core subsystems:
- **`ContextPool`** — task orchestration (the scheduler)
- **`AgentPool`** — process table (agent creation/lookup/disposal)
- **`WindowStateRegistry`** — server-side window compositor state
- **`ReloadCache`** — fingerprint-based action replay (hot reload without re-querying AI)

All server→frontend events flow through `LiveSession.broadcast()`. The session survives WebSocket disconnections — multiple browser tabs share one session via `?sessionId=X`.

---

## Processes (Agents)

Agents are processes. `AgentPool` manages their lifecycle.

| Agent type | OS analogy | Lifecycle | Key | URI |
|---|---|---|---|---|
| **Monitor** | `init` / PID 1 | Persistent per monitor | `monitorId` | `yaar://agents/{instanceId}` |
| **App** | Daemon | Persistent per app (session lifetime) | `appId` | `yaar://agents/{instanceId}` |
| **Ephemeral** | One-shot process | Disposed after single task | (none — tracked in a Set) | `yaar://agents/{instanceId}` |

Monitor agents can spawn **task subagents** via the `Task` tool (like `fork()`). Subagent profiles are defined in `profiles.ts`: `default`, `web`, `code`, `app`.

Global process limit: `AgentLimiter` enforces `MAX_AGENTS` (default 10).

---

## Scheduler

Three policies in `agents/context-pool-policies/` control task dispatch:

**`MainQueuePolicy`** — Per-monitor FIFO queue. Tasks run sequentially (one at a time per monitor). Like a single-core scheduler per virtual desktop.

**`WindowQueuePolicy`** — Per-window FIFO queues. Different windows run in parallel; within one window, tasks serialize. Like multi-core scheduling across independent subsystems.

**`MonitorBudgetPolicy`** — Rate-limits background monitors (not monitor `0`). Three dimensions:
- Concurrent task semaphore (default: 2)
- Action rate (sliding 60s window, default: 30/min)
- Output bytes rate (default: 50KB/min)

The primary monitor is never throttled.

**`ContextAssemblyPolicy`** builds prompts — drains `InteractionTimeline` into `<timeline>` XML and injects skill context into new app agents. **`ReloadCachePolicy`** manages fingerprint-based cache prefix injection into prompts for hot-reload.

---

## Syscalls (MCP Tools)

MCP tools are syscalls. **Verb mode (default):** 2 namespaced HTTP endpoints (`/mcp/system`, `/mcp/verbs`) expose 5 generic URI verbs plus system tools:

| Verb | OS analogy | URI pattern examples |
|---|---|---|
| `describe` | stat / introspect | `yaar://windows/{id}`, `yaar://apps/{id}`, `yaar://browser/{id}` |
| `read` | read / open | `yaar://storage/{path}`, `yaar://sandbox/{path}`, `yaar://skills/{topic}` |
| `list` | readdir / ls | `yaar://windows/`, `yaar://apps/`, `yaar://config/hooks/` |
| `invoke` | ioctl / exec | `yaar://windows/{id}` (create/update), `yaar://sandbox/eval` (JS execution), `yaar://config/app/{id}` |
| `delete` | unlink / rm | `yaar://storage/{path}`, `yaar://windows/{id}`, `yaar://config/hooks/{id}` |

System tools (always active): `reload_cached`, `list_reload_options`. HTTP requests use verb layer: `invoke('yaar://http', { url, ... })`

Domain allowlisting moved to verb layer: `invoke('yaar://config/domains', { domain })`

> **Note:** Legacy named tools (~30 individual tools across 8 namespaces: `system`, `window`, `storage`, `apps`, `user`, `dev`, `basic`, `browser`) are deprecated. See individual domain docs for migration details.

Tools execute inside `AsyncLocalStorage` context so `getAgentId()` routes actions to the correct agent. Results flow back through the `ActionEmitter` → `BroadcastCenter` → WebSocket pipeline.

See [`os_actions_reference.md`](./os_actions_reference.md) for the full action schema.

---

## Instruction Set (System Prompt)

The system prompt **is** the instruction set architecture. It defines:
- The agent's identity and orchestrator role
- All available renderer types (the "display modes")
- The `<timeline>` XML format (event protocol)
- The `<relay>` protocol (inter-agent messaging)
- The `Task` tool delegation pattern (when to handle directly vs. spawn subagents)
- Mandatory `skill()` calls before using app/sandbox/component tools

Located at `providers/claude/system-prompt.ts` (Claude) and `providers/codex/system-prompt.ts` (Codex). Users can override with `config/system-prompt.txt`.

No separate formal ISA document is needed — the prompt itself is concise (~108 lines) and readable.

---

## Boot Sequence

`lifecycle.ts` → `initializeSubsystems()` → `Bun.serve()`:

```
 1. ensureStorageDir()          ← mkdir storage/
 2. loadMounts()                ← warm mount cache, validate host paths
 3. (bundled exe) mkdirs        ← apps/, sandbox/, config/
 4. (remote mode) genToken      ← generate remote access token
 5. initSessionHub()            ← create singleton SessionHub
 6. initMcpServer()             ← register 8 MCP namespaces + bearer token
 7. ensureAppShortcut() × N     ← sync desktop shortcuts for installed apps
 8. initWarmPool()              ← detect provider, pre-initialize instances
 9. Session restore             ← reload prior windows + context from logs

 Bun.serve()                    ← bind HTTP + WebSocket on PORT
```

Shutdown reverses: dispose browser pool → warm pool → WebSocket → HTTP.

---

## Filesystem

The storage subsystem maps to a virtual filesystem:

| Path | OS analogy | Description |
|---|---|---|
| `storage/` | `/home` | Default data directory, path-traversal guarded |
| `storage/mounts/{alias}/` | Mount points | Mapped to host directories via `config/mounts.json` |
| `config/` | `/etc` | Credentials, permissions, hooks, system prompt override |
| `config/credentials/{appId}.json` | `/etc/secrets` | Per-app API keys (git-ignored) |
| `session_logs/{sessionId}/` | `/var/log` | JSONL session logs for context restore |
| `config/reload-cache/` | `/tmp` | Fingerprint-keyed action replay cache |

`resolvePath()` in `storage/storage-manager.ts` handles path resolution: mount prefix → host path, otherwise → `storage/` root. Mounts can be read-only.

---

## Window Manager & Desktop

**Server side — `WindowStateRegistry`** (the compositor):
- Tracks every open window: ID, title, bounds, content, lock state, variant
- Resolves window IDs (exact match or suffix scan)
- Chains window-close callbacks for cache invalidation and agent cleanup

**Client side — React frontend** (the desktop environment):
- Zustand + Immer store manages window layout, z-order, focus
- Content renderers interpret AI-generated payloads (markdown, components, tables, code, etc.)
- WebSocket hook handles reconnection and event dispatch

See [`monitor_and_windows_guide.md`](./monitor_and_windows_guide.md) for the full Session → Monitor → Window hierarchy.

---

## IPC

Four IPC mechanisms:

**`ActionEmitter`** (`mcp/action-emitter.ts`) — The syscall return path. MCP tools emit OS Actions here; listeners route them to WebSocket delivery. Supports fire-and-forget (`emitAction`) and request/response (`emitActionWithFeedback`, `showConfirmDialog`, `showPermissionDialog`, `showUserPrompt`).

**`BroadcastCenter`** (`session/broadcast-center.ts`) — Display server. Routes serialized events to WebSocket connections, scoped by session or monitor. Connections with no monitor subscription receive all events (backward compat).

**`InteractionTimeline`** (`agents/interaction-timeline.ts`) — Unified chronological log of user UI interactions and AI action summaries. Drained into `<timeline>` XML by `ContextAssemblyPolicy` and prepended to the next monitor agent prompt. Deduplicates redundant events (e.g., focus before resize).

**App Protocol** — Bidirectional agent↔iframe communication for apps with `"appProtocol": true`. Commands sent via `emitAppProtocolRequest()`, responses resolved via `resolveAppProtocolResponse()`. See [`app_protocol_reference.md`](./app_protocol_reference.md).

---

## Applications

Convention-based: each folder in `apps/` is an app. `SKILL.md` defines what the AI knows about it. `app.json` provides metadata (icon, variant, visibility, file associations).

Hidden apps (`"hidden": true`) inject their skill into the system prompt automatically — system-level capabilities the AI always knows about.

Marketplace tools (`apps_market_list`, `apps_market_get`, `apps_market_delete`) handle install/uninstall.

See the Apps System section in the root `CLAUDE.md` for the full schema.

---

## Providers as Device Drivers

`AITransport` is the driver interface. Two implementations:

| Provider | Transport | File |
|---|---|---|
| Claude | `@anthropic-ai/claude-agent-sdk` | `providers/claude/session-provider.ts` |
| Codex | JSON-RPC over WebSocket | `providers/codex/provider.ts` |

**Warm pool** (`providers/warm-pool.ts`): Pre-initializes provider instances at startup. `acquire()` shifts from pool and triggers async replenishment. Auto-detects provider from environment (`PROVIDER` env var) or probes Claude → Codex availability.

See [`claude_codex.md`](./claude_codex.md) for behavioral differences between providers.

---

## Summary

```
┌─────────────────────────────────────────────────────┐
│                   Frontend (DE)                     │
│  Zustand store · Content renderers · WebSocket hook │
├─────────────────────────────────────────────────────┤
│              BroadcastCenter (Display)              │
│         Session/Monitor-scoped event routing        │
├─────────────────────────────────────────────────────┤
│                ActionEmitter (IPC)                  │
│        Syscall returns · Dialogs · App Protocol     │
├─────────────────────────────────────────────────────┤
│              MCP Tools (Syscalls)                   │
│  system · window · storage · apps · user · dev ·    │
│  browser                                            │
├─────────────────────────────────────────────────────┤
│              LiveSession (Kernel)                   │
│  ContextPool · AgentPool · WindowStateRegistry ·    │
│  ReloadCache                                        │
├──────────────────────┬──────────────────────────────┤
│   Scheduler          │     Agents (Processes)       │
│  MainQueuePolicy     │  Main · App · Ephemeral ·    │
│  WindowQueuePolicy   │  Task subagents              │
│  MonitorBudgetPolicy │                              │
├──────────────────────┴──────────────────────────────┤
│           AITransport (Device Drivers)              │
│         Claude (Agent SDK) · Codex (JSON-RPC)       │
├─────────────────────────────────────────────────────┤
│                 Storage (VFS)                       │
│       storage/ · mounts · config/ · logs            │
└─────────────────────────────────────────────────────┘
```
