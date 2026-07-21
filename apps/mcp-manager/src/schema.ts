// Boundary schemas for mcp-manager's trust boundaries.
//
// This app talks to *remote, untrusted* MCP servers and hand-parses their
// JSON-RPC / SSE responses. These schemas validate the shape of that data
// (and of the persisted `yaar://config/mcp` blob) before the code reads
// fields off it — they are trust-boundary checks, not domain type declarations.
// Every object is loose so additive upstream fields survive, and we validate
// only the fields the app actually reads.
//
// `@bundled/zod` is Zod Mini (functional API): `z.optional(z.string())`,
// `z.safeParse(Schema, data)`. Mini tree-shakes to ~10KB; standard Zod would
// add ~260KB.
import * as z from '@bundled/zod';

// JSON-RPC 2.0 response envelope, as returned by a remote MCP server either as
// direct JSON (main.ts:69) or inside an SSE `data:` line (main.ts:78). Both
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

// Persisted MCP config read at main.ts:175 via `read('yaar://config/mcp')`.
// The app reads `.servers` and, per entry, `.type` (with optional `url`/`command`).
const McpServerConfig = z.looseObject({
  type: z.string(),
  url: z.optional(z.string()),
  command: z.optional(z.string()),
});

export const McpConfigResponse = z.looseObject({
  servers: z.optional(z.record(z.string(), McpServerConfig)),
});
