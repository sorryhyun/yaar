# MCP Manager — notes for whoever edits this next

Discovers, probes and manages external MCP (Model Context Protocol) servers.
It is a client for *remote, untrusted* servers, which is the fact that shapes
most of the design decisions below.

## Layout

Each module has one job, and the dependency graph runs strictly downward —
nothing below imports anything above it.

```
main.ts        entry point; wires protocol + view into defineApp, nothing else
protocol.ts    the agent-facing surface (state keys + commands)
ui/            the view — markup only, no behaviour
  App.ts         shell + the gateway subscription that makes the list "live"
  ProbeSection.ts / ScanSection.ts / ServerList.ts   the three sections
  DiscoveredCard.ts / ToolList.ts                    shared pieces
actions.ts     every mutation and multi-step operation
store.ts       reactive state atoms (signals + memos), no behaviour
gateway.ts     the YAAR data layer: yaar://mcp, yaar://config/mcp
mcp.ts         the MCP wire protocol: JSON-RPC framing, transport, probing
tools.ts       tool-list parsing, shared by both boundaries that produce one
schema.ts      Zod schemas validating untrusted payloads
types.ts       internal domain shapes
constants.ts   URIs, defaults, protocol literals
log.ts         one shape for logging / reporting a failure
```

The split that matters most is **gateway.ts vs mcp.ts**: `mcp.ts` speaks to
remote servers over HTTP, `gateway.ts` speaks to YAAR's own MCP resource. They
are different trust domains and different failure modes; keep them apart.

## Invariants

**The protocol is public.** `protocol.json` is regenerated on every compile and
other agents call these commands. Renaming a state key or a command, or
narrowing a `params` schema, is a breaking change — `deploy` will refuse a
manifest that drops commands unless forced. After any restructuring, run the
`manifest` command (needs a compile *and* an open preview) to confirm the
static and runtime manifests still match.

**Descriptors must stay statically readable.** The build extracts `appState`
and `appCommands` from source: plain `const` object literals, no factory calls,
no computed descriptions. Commands are wrapped in `defineAppCommand` so each
`params` schema keeps typing its own `run` across the spread into `defineApp`.

**Never evaluate an `html` template at module scope.** Every `html` call sits
inside a function. A module-scope one builds a `<template>` element on import,
which breaks the worker that extracts Zod `params` — and takes the *entire*
manifest down with it, not just the one command.

**Validate at the boundary, convert to internal types.** schema.ts describes
what arrives; types.ts describes what the app passes around. Every object is
`z.looseObject` so additive upstream fields survive, and only fields the app
actually reads are validated. Rows inside a list are parsed one at a time so a
single malformed entry costs that entry, not the whole list — an emptied tool
list renders as the ambiguous "No tools or not connected".

`@bundled/zod` is **Zod Mini** (functional API: `z.optional(z.string())`,
`z.safeParse(Schema, data)`). Mini tree-shakes to ~10KB; standard Zod adds ~260KB.

**Error convention.** An action called from the UI reports its own failure
(`reportError`, or `tryToast`) and resolves. An action a protocol command calls
directly — `startScan`, `addServerByUrl`, `removeServerByName`,
`refreshServerByName` — throws, so the agent gets the message instead of a
silent success. `reportError(context, err)` renders as "context: reason"; keep
using it rather than hand-rolling console.error + showToast.

**Protocol version negotiation.** The client speaks `2025-06-18`, but echoes
back whatever `protocolVersion` the server returned from `initialize` in the
`MCP-Protocol-Version` header on every later request. That header and
`mcp-session-id` must ride every non-initialize request; omitting the former
makes a spec-current server assume 2025-03-26 or reject outright.

**Only HTTP transport can be registered.** A `stdio` server already in the
config renders in the list but cannot be added or reconfigured here.

## Traps

- `probePort` swallows *every* error as "nothing here" — that is right for a
  port sweep, but it means a systemic failure (a missing permission, say)
  looks exactly like an empty network. It now logs each miss via `logDebug`,
  so open the console and look for repeated `[mcp-manager] probe ... failed`
  lines with an identical reason: that is the signature of a systemic fault
  rather than a quiet network. Probing a single URL by hand also reports the
  real reason, since that path does not swallow.
- `parseRpcResponse` must not wrap the direct-JSON branch in a try that falls
  through to the SSE scan. A previous version did, and it swallowed the
  server's own `error.message` — the most useful thing in the exchange —
  re-reporting everything as "Could not parse MCP response".
- Solid's `html` wraps *component* props in reactive getters, so a handler
  passed as a prop fires during render. `ScanField` and `ToolList` are called
  as plain functions (`${ScanField({...})}`) precisely to avoid this.
- `SCAN_DEFAULTS` is `as const`, so signals initialised from it need an
  explicit type parameter or they pin to their initial literal.

## Permissions: declare the exact URI, not just the prefix

From v1.0.0 to v2.0.2 app.json declared `"yaar://http/"` — with a trailing
slash — while the code invokes the exact URI `yaar://http`. A trailing-slash
prefix does **not** cover the slashless exact URI, so every outbound HTTP call
was refused with `Not permitted: invoke yaar://http`. Because `probePort`
swallows errors, this presented as "the network is empty" rather than as a
failure: scans found nothing, forever. Fixed in 2.0.3.

The rule to keep: **declare every form the code actually targets.** Verbs are
not interchangeable here either — `read`/`list` on `yaar://config/mcp` worked
under the slash form while `invoke` on `yaar://http` did not, so do not assume
one passing call proves the whole grant.

Current call sites, and why each entry exists:

| Target | Verbs | Declared |
|---|---|---|
| `yaar://mcp` | list, invoke (add/remove/refresh), subscribe | `yaar://mcp` |
| `yaar://mcp/{name}` | list | `yaar://mcp/` |
| `yaar://config/mcp` | read | `yaar://config/mcp` + `yaar://config/mcp/` |
| `yaar://http` | invoke, via `httpFetch` | `yaar://http` |

If you add a call to a new URI shape, add its exact form to `permissions` and
verify it in the real app — a Dev Tools preview cannot reach past Dev Tools'
own permissions, so `yaar://mcp` and `yaar://config/mcp` always fail there and
prove nothing either way.