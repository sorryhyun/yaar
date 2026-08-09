# Tracing seam proposal

**Status:** proposal
**Scope:** `packages/server` only. No frontend, no new runtime dependency in the default build.

## The problem

A single user message crosses eight named seams before pixels change, and the tree nests three
tiers deep (monitor agent → app agent → sub-agent). Today that path is observable only through
301 unstructured `console.log/warn/error` calls in `packages/server/src` and one bespoke ring
buffer (`streams/stream-diagnostics.ts`) that answers exactly one question about exactly one
seam.

The questions we currently cannot answer without reading a log by eye:

- Where did the 9 seconds go — queue wait, prompt assembly, or the provider?
- Which turn spawned this app-agent turn? (The timeline flattens the tree; the tree is gone.)
- How many verb calls did that turn make, and how long did the slow one take?
- Did time-to-first-token regress after a prompt change?

`stream-diagnostics.ts` exists because someone needed one of these badly enough to hand-roll it.
This generalizes that module rather than replacing it.

## Non-goals

- **Not** adopting the OpenTelemetry SDK into the default build. See "Why not the SDK" below.
- **Not** replacing `SessionLogger`. Spans are timings; the session log is content. Different
  files, different retention, different privacy posture.
- **Not** distributed tracing. There is one process.

## Design

### 1. A closed attribute vocabulary (the privacy guarantee)

`stream-diagnostics.ts` states the rule this proposal inherits:

> A transcript must not be reachable through a debug switch.

Enforced structurally rather than by review: the attribute key type is a **closed union**, so
there is no key a prompt, a response, or a filename could be written to. Adding a key is a
deliberate one-file edit that shows up in review.

```ts
// observability/attrs.ts
export type SpanAttrKey =
  // identity — ids we already mint, never user-supplied strings
  | 'yaar.session_id' | 'yaar.monitor_id' | 'yaar.window_id'
  | 'yaar.agent_id'   | 'yaar.agent_role' | 'yaar.app_id'
  | 'yaar.task_kind'  | 'yaar.task_requested_type'
  // counts and outcomes
  | 'yaar.content_chars' | 'yaar.action_count' | 'yaar.queue_depth'
  | 'yaar.outcome'       // 'completed' | 'interrupted' | 'failed'
  | 'yaar.action_type'   // OSAction discriminant, a closed set
  | 'yaar.verb'          // describe | read | list | invoke | delete
  | 'yaar.uri_authority' // 'storage' | 'apps' | 'windows' | … NEVER the full URI
  // GenAI semantic conventions, borrowed verbatim
  | 'gen_ai.system' | 'gen_ai.request.model'
  | 'gen_ai.usage.input_tokens'  | 'gen_ai.usage.output_tokens'
  | 'gen_ai.usage.cache_read_tokens' | 'gen_ai.usage.cache_write_tokens';

export type SpanAttrs = Partial<Record<SpanAttrKey, string | number | boolean>>;
```

Two entries carry the load:

- **`yaar.content_chars`, not content.** Same choice `StreamCadenceSample` already makes.
- **`yaar.uri_authority`, not the URI.** `yaar://storage/notes/tax-return-2025.pdf` is content
  wearing an identifier's clothes. The authority (`storage`) is the useful dimension for
  "which subsystem is slow"; the path is the part that leaks.

Borrowing the `gen_ai.*` names costs nothing now and means an OTLP export lands in any
GenAI-aware backend already labelled correctly.

### 2. The seam itself

```ts
// observability/span.ts
export interface SpanContext { traceId: string; spanId: string }

export function startSpan<T>(
  name: SpanName,
  attrs: SpanAttrs,
  fn: (span: Span) => Promise<T>,
): Promise<T>;

export function currentSpanContext(): SpanContext | undefined;
export function withSpanContext<T>(ctx: SpanContext, fn: () => T): T;
```

- Its own `AsyncLocalStorage`, **not** a field on `AgentContext`. `runWithAgentContext`
  (`agents/agent-context.ts:131`) rebuilds its store field by field on purpose — its own comment
  warns that a new field must be added in two places or it silently vanishes. Span context nests
  on a different schedule than agent identity (a verb span is nested inside one agent context;
  a turn span spans two). A separate ALS keeps both invariants simple.
- **Off by default.** When disabled, `startSpan` is `fn(NOOP_SPAN)` after one boolean check —
  the `YAAR_STREAM_DIAG` pattern, same hot-path cost.
- `SpanName` is a closed union too, so the span tree's shape is a reviewable list.

### 3. Where the spans go — real call sites

| Span | Site | Notes |
|---|---|---|
| `yaar.message` | `LiveSession.routeMessage` — `session/live-session.ts:589` | Root. One per inbound client frame. |
| `yaar.task` | `ContextPool.handleTask` — `agents/context-pool.ts:469` | Attributes from `Task.kind` / `requestedType`. |
| `yaar.queue_wait` | `MonitorQueuePolicy` dequeue → `runMonitorTurn` — `agents/monitor-task-processor.ts:192` | **`QueuedTask.timestamp` (`pool-types.ts`) already records the start.** The span is a projection of state we keep today. |
| `yaar.turn` | `runMonitorTurn` :192, `runEphemeralTurn` :247, and the `AppTaskProcessor` equivalent | The tier boundary. `yaar.agent_role` distinguishes them. |
| `yaar.prompt_assembly` | `AgentSession.assembleSystemPrompt` — `agents/agent-session.ts:318`, awaited at :461 | Loads app agent docs; suspected but unmeasured cost. |
| `gen_ai.chat` | The `runInAgentContext` block — `agents/agent-session.ts:519-535` | Wraps the `for await` provider loop at :530. Closed in the `finally` at :546 so interrupt and throw both land. |
| `yaar.verb` | `ResourceRegistry.execute` — `handlers/uri-registry.ts:268` | Authority + verb only. Covers both doors (MCP tools and `POST /api/verb`). |
| `yaar.action` (event) | `ToolActionBridge.handleToolAction` — `agents/session-policies/tool-action-bridge.ts:27` | An **event on the turn span**, not a span. It is fast and high-cardinality; a span each would be noise. |

Two derived measurements recorded on `gen_ai.chat` rather than as spans:

- **time-to-first-token** — first `text` message in the `for await` loop minus span start.
- **token usage** — `AgentSession.recordUsage`, already wired as `onUsage` at
  `agent-session.ts:509`. `TokenUsage` (`providers/types.ts:31`) maps field-for-field onto the
  four `gen_ai.usage.*` keys, cache counts included. This is the one place today where a genuinely
  useful number is computed and then only displayed.

### 4. The queue boundary — the one real implementation problem

AsyncLocalStorage propagates through promise chains, but **not** across an enqueue that a
different async context later drains. Every tier transition here is exactly that: `handleTask`
enqueues, `processMonitorQueue` (`monitor-task-processor.ts:292`) drains. Without handling it,
every turn is its own root and the tree — the entire point — is lost.

Fix, and it is the same carrier-injection an OTEL integration would need:

```ts
export interface Task {
  // …
  /** Trace carrier. Stamped at enqueue, re-entered at dequeue — ALS does not
   *  survive a queue, so the parent link has to ride on the task itself. */
  trace?: SpanContext;
}
```

Stamp in `handleTask`, re-enter with `withSpanContext` in the processors. Sub-agents
(`sub-agent-registry.ts`) bypass `ContextPool` entirely, so they need the same stamp at spawn or
they hang off the root instead of their owning app agent.

### 5. Exporters

`YAAR_TRACE` — unset/`0` (default, off), `jsonl`, `otlp`.

- **`jsonl`** — `spans.jsonl` in the existing `session_logs/{timestamp}/` directory, written
  through the buffered append `SessionLogger` already has (`bufferLine` :201, `scheduleFlush`
  :210). Costs no new I/O machinery, and `logging/prune.ts` already sweeps empty session dirs.
- **`otlp`** — `YAAR_TRACE_OTLP_ENDPOINT`, behind a **dynamic** `import()` of
  `@opentelemetry/exporter-trace-otlp-http`, as an optional dependency. This is the codebase's
  existing rule for SDK weight: "Dynamic imports keep SDK dependencies lazy."

### Why not the OTEL SDK as the primary

1. **Bundle weight in a single-file executable.** YAAR ships as `build:exe:bundle:{linux,macos}`.
   The SDK plus a resource detector is real megabytes, paid by every user, and approximately none
   of them run a collector.
2. **Off-by-default is the honest default here**, and a global tracer provider installed at boot
   is not that.
3. **The span model is the valuable part; the SDK is the transport.** Take the model and the
   `gen_ai.*` naming now, keep the transport optional, and the OTLP path stays a ~40-line exporter
   rather than a rewrite.

If YAAR ever grows a hosted multi-tenant deployment, swapping the internal seam for the real SDK
is a contained change — every call site already speaks spans.

## Cost

| | LOC |
|---|---|
| `observability/` (span, attrs, jsonl exporter, noop) | ~250 |
| Call-site instrumentation (8 sites) | ~60 |
| `Task.trace` carrier + 3 re-entry points | ~25 |
| OTLP exporter (optional dep) | ~40 |
| Tests | ~150 |

## Test-suite requirement

Both knobs carry the `YAAR_` prefix, so `scripts/test/env.ts`'s prefix sweep already scrubs them
— no addition to the explicit `SCRUBBED` list is needed. The requirement is only that they *keep*
that prefix: the repo's rule is "a test never depends on the machine it runs on", and a
non-prefixed name would need adding to the list by hand.

## Recommended sequencing

This proposal is **second**, and the first step is now done: structured logging landed in
`packages/server/src/observability/log.ts`, and all 307 non-exempt `console.*` calls in
`packages/server/src` now carry `sessionId` / `monitorId` / `agentId` automatically, with
`no-console` as an ESLint error to hold it. Two things that changes for this proposal:

- **`createLogger`'s injected-resolver shape is the precedent to copy.** `observability/log.ts`
  imports nothing and gets its ambient ids from `setLogContextResolver`, wired in `lifecycle.ts`.
  A span module should do exactly the same rather than importing `agent-context` directly.
- **The closed-vocabulary argument has been tested against real call sites.** Converting the 307
  turned up two live content leaks (a 50-char prompt excerpt in `AgentSession`, an image data-URL
  prefix in the Claude provider) that no reviewer had flagged. That is the evidence for making
  `SpanAttrKey` a closed union rather than a convention.

What remains unanswerable from logs alone — and so still justifies spans — is duration
attribution: which of queue-wait, prompt assembly, or the provider consumed a slow turn, and
which parent turn spawned a given app-agent turn.

## Rejected: NATS

Considered alongside this and rejected. `BroadcastCenter` (`session/broadcast-center.ts`) fans out
to an in-memory `Map` of connections in one process; the distribution model is a single-file
executable, and remote mode is a Tailscale tunnel to the same user's other devices. Adopting NATS
means embedding or requiring a broker to gain nothing until sessions shard across instances —
which would be a reversal of the product's shape, not an increment on it.
