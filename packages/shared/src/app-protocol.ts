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

/**
 * Declares an event channel an app can emit on (via `app.emit(channel, payload)`).
 * Surfaced in the manifest so an agent can discover what it may subscribe to.
 */
export interface AppEventDescriptor {
  description: string;
}

export interface AppManifest {
  appId: string;
  name: string;
  state: Record<string, AppStateDescriptor>;
  commands: Record<string, AppCommandDescriptor>;
  /** Declared event channels this app may emit. Absent for apps that emit nothing. */
  events?: Record<string, AppEventDescriptor>;
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

/** Fire-and-forget notification sent to iframe before window is destroyed. */
export interface AppCloseNotification {
  type: 'yaar:app-close';
}

/**
 * Fire-and-forget event pushed from the iframe app to the parent (agent side).
 * Emitted via `app.emit(channel, payload)`. The parent resolves the source
 * iframe → windowId (the iframe doesn't know its own windowId).
 */
export interface AppEventMessage {
  type: 'yaar:app-event';
  channel: string;
  payload: unknown;
}

export type AppProtocolPostMessage =
  | AppManifestRequest
  | AppManifestResponse
  | AppQueryRequest
  | AppQueryResponse
  | AppCommandRequest
  | AppCommandResponse
  | AppCloseNotification
  | AppEventMessage;

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
