// Boundary schemas for mcp-manager's trust boundaries.
//
// This app talks to *remote, untrusted* MCP servers and hand-parses their
// JSON-RPC / SSE responses. These schemas validate the shape of that data
// (and of the persisted `yaar://config/mcp` blob) before the code reads
// fields off it — they are trust-boundary checks, not domain type declarations.
// The internal shapes the app actually passes around live in types.ts.
// Every object is loose so additive upstream fields survive, and we validate
// only the fields the app actually reads.
//
// `@bundled/zod` is Zod Mini (functional API): `z.optional(z.string())`,
// `z.safeParse(Schema, data)`. Mini tree-shakes to ~10KB; standard Zod would
// add ~260KB.
import * as z from '@bundled/zod';

// JSON-RPC 2.0 response envelope, as returned by a remote MCP server either as
// direct JSON or inside an SSE `data:` line (both in `parseRpcResponse`). Both
// boundaries share this exact shape, so a single schema covers both. The code
// only ever reads `.result` and `.error.message`.
const JsonRpcError = z.looseObject({
  code: z.optional(z.number()),
  message: z.optional(z.string()),
});

export const JsonRpcResponse = z.looseObject({
  jsonrpc: z.optional(z.string()),
  id: z.optional(z.union([z.string(), z.number()])),
  result: z.optional(z.unknown()),
  error: z.optional(JsonRpcError),
});

// The schemas below sit behind `parseRpcResponse`, which only guarantees "some
// JSON-RPC result came back". The result *payload* is still whatever a remote
// server chose to send, so it gets validated rather than cast — the `as` casts
// these replaced were unchecked assertions about an untrusted peer.

// `initialize` result. `protocolVersion` is what the server negotiated down to;
// the app echoes it back in the MCP-Protocol-Version header on every subsequent
// request, so reading it correctly matters more than any display field.
export const McpInitializeResult = z.looseObject({
  protocolVersion: z.optional(z.string()),
  serverInfo: z.optional(
    z.looseObject({
      name: z.optional(z.string()),
      version: z.optional(z.string()),
    }),
  ),
});

// A list of tools, from either of the two boundaries that produce one: a remote
// server's `tools/list` RPC result, and the gateway's `list('yaar://mcp/{name}')`.
// The two payloads are the same shape and are parsed by the same helper
// (`parseToolList`), so they share one schema rather than two identical copies.
//
// Rows stay `unknown` and are parsed one at a time with `McpToolInfo` below, so
// one malformed tool costs that tool and not the whole list — an emptied list
// would show in the UI as the ambiguous "No tools or not connected".
export const McpToolListEnvelope = z.looseObject({
  tools: z.optional(z.array(z.unknown())),
});

// One row of that list. `name` is what renders, so it is required;
// `description` is decoration.
export const McpToolInfo = z.looseObject({
  name: z.string(),
  description: z.optional(z.string()),
});

// Persisted MCP config read in `fetchServers` via `read('yaar://config/mcp')`.
// The app reads `.servers` and, per entry, `.type` (with optional `url`/`command`).
// `url` is also what dedupes a scan result against an already-configured server.
// Exported so `fetchServers` can name the record's value type: `servers ?? {}`
// widens to `Record<string, McpServerConfig> | {}`, and `Object.entries` over
// that union hands back `unknown` values.
export const McpServerConfig = z.looseObject({
  type: z.string(),
  url: z.optional(z.string()),
  command: z.optional(z.string()),
});

export const McpConfigResponse = z.looseObject({
  servers: z.optional(z.record(z.string(), McpServerConfig)),
});

// Runtime status from `list('yaar://mcp')`, joined against the config above by
// `name` — so `name` is required (a row without one can never be joined) while
// every display field is optional and defaulted at the join site.
//
// Rows are `unknown` in the envelope and parsed one at a time: a status row the
// server shapes differently should cost that server its live state, not blank
// the whole list, which would make every configured server read as
// "disconnected".
export const McpServerStatus = z.looseObject({
  name: z.string(),
  state: z.optional(z.string()),
  error: z.optional(z.string()),
  toolCount: z.optional(z.number()),
});

export const McpStatusListResponse = z.looseObject({
  servers: z.optional(z.array(z.unknown())),
});