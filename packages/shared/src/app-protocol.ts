/**
 * App Protocol — self-describing JSON contract for agent ↔ iframe app communication.
 *
 * Apps register a manifest describing their capabilities (state keys, commands).
 * The agent discovers capabilities at runtime, then queries state or sends commands.
 *
 * Flow:
 *   Agent → MCP tool → ActionEmitter → WebSocket → Frontend → postMessage → Iframe App
 *   Iframe App → postMessage → Frontend → WebSocket → ActionEmitter resolves → MCP tool returns
 */

// ── File association types ──────────────────────────────────────────

/** Declares which file types an app can open and how to send content to it. */
export interface FileAssociation {
  extensions: string[];
  command: string;
  paramKey: string;
}

// ── Manifest types ──────────────────────────────────────────────────

export interface AppStateDescriptor {
  description: string;
  schema?: object;
}

export interface AppCommandDescriptor {
  description: string;
  aliases?: string[];
  params?: object;
  returns?: object;
}

export interface AppManifest {
  appId: string;
  name: string;
  state: Record<string, AppStateDescriptor>;
  commands: Record<string, AppCommandDescriptor>;
}

// ── PostMessage types (parent ↔ iframe) ─────────────────────────────

export interface AppManifestRequest {
  type: 'yaar:app-manifest-request';
  requestId: string;
}

export interface AppManifestResponse {
  type: 'yaar:app-manifest-response';
  requestId: string;
  manifest: AppManifest | null;
  error?: string;
}

export interface AppQueryRequest {
  type: 'yaar:app-query-request';
  requestId: string;
  stateKey: string;
}

export interface AppQueryResponse {
  type: 'yaar:app-query-response';
  requestId: string;
  data: unknown;
  error?: string;
}

export interface AppCommandRequest {
  type: 'yaar:app-command-request';
  requestId: string;
  command: string;
  params?: unknown;
}

export interface AppCommandResponse {
  type: 'yaar:app-command-response';
  requestId: string;
  result: unknown;
  error?: string;
}

export type AppProtocolPostMessage =
  | AppManifestRequest
  | AppManifestResponse
  | AppQueryRequest
  | AppQueryResponse
  | AppCommandRequest
  | AppCommandResponse;

// ── WebSocket event types (server ↔ client) ─────────────────────────

/** Server → Client: ask the iframe a question */
export type AppProtocolRequest =
  | { kind: 'manifest' }
  | { kind: 'query'; stateKey: string }
  | { kind: 'command'; command: string; params?: unknown };

/** Client → Server: iframe's answer */
export type AppProtocolResponse =
  | { kind: 'manifest'; manifest: AppManifest | null; error?: string }
  | { kind: 'query'; data: unknown; error?: string }
  | { kind: 'command'; result: unknown; error?: string };
