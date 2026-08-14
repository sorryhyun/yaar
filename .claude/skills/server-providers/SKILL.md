---
name: server-providers
description: YAAR AI provider internals - AITransport contract, the notice vs error rule, warm pool, Codex packaging. Use when editing packages/server/src/providers/ or a provider's stream mapping.
paths:
  - "packages/server/src/providers/**"
---

# Server Providers

**AITransport interface:** `systemPrompt`, `isAvailable()`, `query(prompt, options)` → async iterable of `StreamMessages`, `interrupt()`, `dispose()`.

**Warm Pool:** Providers pre-initialized at startup. `initWarmPool()` at boot, `acquireWarmProvider()` gets a ready instance, pool auto-replenishes in background.

**Claude:** `claude-sonnet-5`, thinking enabled (4096 max tokens), WebSearch and Task tools, `bypassPermissions`. Each provider keeps a **persistent streaming session**: one long-lived CLI process whose MCP connections survive across turns; turns push messages into the stream and read until the SDK result. A prompt/tools/model change reopens the stream with `resume`. Monitor agents are prewarmed at WebSocket connect (`ContextPool.prewarmMonitorAgent` → `AgentSession.prewarm` → `provider.prewarm`) so the first user message starts on a live process with MCP already connected — the first turn is also gated on MCP connection (bounded 5s) because the CLI no longer waits for HTTP MCP servers in stream-json mode.

**Codex:** `codex app-server` child process with per-provider WebSocket connections (`--listen ws://`). Settings: `approval_policy=on-request`, `model_reasoning_effort=medium`, `sandbox_mode=danger-full-access`.

### The `notice` contract (`providers/notice.ts`)

Both SDKs report trouble on far more channels than they report *fatal* trouble on. **A
recoverable failure becomes `StreamMessage.type === 'notice'`, never `error`.**

`error` is terminal by contract — `StreamToEventMapper.map` calls `fail()`, which latches the turn
closed, and both providers' read loops stop on it — so reporting a retryable failure that way ends
the turn in the UI while the provider carries on working. Notices reach the client as
`ServerEventType.AGENT_NOTICE` (a CLI-panel line, never `connectionError` and never a failed
message) and as a `notice` frame on `yaar://agents/{id}/stream`.

`ProviderNotice` + `toNoticeMessage` live in `providers/notice.ts`; each provider's vocabulary
lives beside its mapper in `claude/errors.ts` and `codex/errors.ts`. **Which channel maps to
which, per provider, is
[`docs/reference/claude_codex.md`](../../../docs/reference/claude_codex.md#error-recovery)** —
including the one case where the mapper and the read loop must agree (Codex `willRetry`). Covered
by `tests/claude-error-notices.test.ts` and `tests/codex-error-notices.test.ts`.

### Codex packaging

Full regeneration workflow and refusal gates are in the `codex-provider` skill
(`.claude/skills/codex-provider/SKILL.md`) — read that first.

`@openai/codex` is declared as an **optional peer dependency** so a Codex user can pin the CLI to
the lockfile (`bun add @openai/codex`) instead of driving whatever PATH resolves first, while a
plain `bun install` downloads none of it. `getCodexSpawnArgs()` (`config/providers/codex.ts`)
resolves the **vendored binary** directly and never the package's `bin/codex.js` — the reasons,
and why pinning retires no gate, are in that function's comments. The declared range is pinned to
`CODEX_MIN_VERSION` by test, since stated in two files it would drift into admitting a CLI the
gates refuse.
