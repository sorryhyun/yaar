/**
 * Server → Client WebSocket event interfaces and the discriminated union over them.
 */

import type { CapabilityLine, OSAction, PermissionOptions } from '../actions.js';
import type { AppProtocolRequest } from '../app-protocol.js';
import { ServerEventType } from './routing.js';

// ============ Server → Client Events ============

export interface ActionsEvent {
  type: typeof ServerEventType.ACTIONS;
  actions: OSAction[];
  agentId?: string;
  monitorId?: string;
}

export interface AgentThinkingEvent {
  type: typeof ServerEventType.AGENT_THINKING;
  content: string;
  agentId?: string;
  monitorId?: string;
}

export interface AgentResponseEvent {
  type: typeof ServerEventType.AGENT_RESPONSE;
  content: string;
  isComplete: boolean;
  agentId?: string;
  monitorId?: string;
  messageId?: string;
}

/**
 * What the server did with the session id the client asked for.
 *
 * - `attached` — the requested session was still live in the hub; same incarnation,
 *   same agents, same windows. This is the only mode that means true continuity.
 * - `restored` — a new incarnation seeded from state the server read off disk at boot.
 *   Windows come back; provider conversations do not.
 * - `replaced` — a new, empty incarnation under the requested id, because the old one
 *   was evicted or never existed in this process. Any local state the client still
 *   holds for that id is stale.
 * - `created` — the client asked for nothing and got a brand-new session.
 */
export type RecoveryMode = 'attached' | 'restored' | 'replaced' | 'created';

/**
 * The attachment handshake: sent to a single connection once it is bound to a LiveSession.
 *
 * An open WebSocket only means transport exists. This event is what says *which* session
 * incarnation the transport is bound to, so the client can tell a genuine reattachment
 * from a replacement wearing the same session id.
 */
export interface SessionAttachedEvent {
  type: typeof ServerEventType.SESSION_ATTACHED;
  /** The hub's key for this session — what the client echoes back on rejoin. */
  sessionId: string;
  /**
   * Identifies the session *incarnation*, not the id. A session id outlives eviction and
   * process restarts; the epoch does not. A client that sees the same sessionId with a
   * different epoch is talking to a different session that merely reuses the name.
   */
  sessionEpoch: number;
  /** This connection's id in the BroadcastCenter — distinct per tab. */
  connectionId: string;
  recoveryMode: RecoveryMode;
  provider?: string;
  /** See ConnectionStatusEvent.logSessionId — the transcript on disk, a different namespace. */
  logSessionId?: string;
}

/**
 * Provider status. Not an attachment signal — SessionAttachedEvent is what binds a
 * connection to a session incarnation, and the client must not treat CONNECTION_STATUS
 * as proof that it happened.
 */
export interface ConnectionStatusEvent {
  type: typeof ServerEventType.CONNECTION_STATUS;
  status: 'connected' | 'disconnected' | 'error';
  provider?: string;
  /**
   * The live session's id in the SessionHub. This is the id the client must echo back
   * — `?sessionId=` on WebSocket rejoin, and the `sessionId` an iframe token is minted
   * against — so it has to be the hub's key, not the log directory's name.
   */
  sessionId?: string;
  /**
   * The session_logs/ directory name (`YYYY-MM-DD_HH-MM-SS`), which is what the
   * `/api/sessions/*` history endpoints are keyed by. A different namespace from
   * `sessionId`: it names a transcript on disk, not a session in the hub.
   */
  logSessionId?: string;
  error?: string;
}

export interface ToolProgressEvent {
  type: typeof ServerEventType.TOOL_PROGRESS;
  toolName: string;
  /**
   * Where the call is.
   *
   * `'pending'` is the *parameter-generation* phase: the model has named a tool
   * but is still writing its arguments, which for a large input (a long file
   * body, a big component tree) takes seconds to tens of seconds. Without it the
   * whole window is silent — the call only became visible once its arguments
   * were complete. A `pending` event with no `message` announces the tool name;
   * subsequent `pending` events carry a raw argument fragment in `message`.
   *
   * Only providers that expose argument deltas emit `pending` (Claude does;
   * Codex delivers arguments whole), so a consumer must treat the phase as
   * optional enrichment and stay correct when a call goes straight to
   * `'running'`.
   *
   * `'output'` is the mirror image on the far side of the call: the tool is
   * running and producing output, and each event carries the next chunk of it in
   * `message`. It exists for the same reason as `pending` — a command that takes
   * a minute used to be a minute of silence broken only by its finished result.
   * Events arrive in order and are meant to be *appended*; unlike `complete`,
   * `message` is a fragment and not the whole. Only providers that expose output
   * deltas emit it (Codex does, via `item/commandExecution/outputDelta`), so it
   * too is optional enrichment: a call may go `running` → `complete` with
   * nothing in between.
   */
  status: 'pending' | 'running' | 'output' | 'complete' | 'error';
  /**
   * Result text on `complete`/`error`. On `pending`, a raw fragment of the
   * argument JSON — **display only**. It is a prefix of a JSON document, not a
   * document: parsing it will fail or, worse, half-succeed. On `output`, the
   * next chunk of the tool's stdout/stderr, to be appended to the chunks before
   * it.
   */
  message?: string;
  toolInput?: unknown;
  agentId?: string;
  monitorId?: string;
}

export interface ErrorEvent {
  type: typeof ServerEventType.ERROR;
  error: string;
  agentId?: string;
  monitorId?: string;
  /**
   * The user message this error is *about*, when it is about one.
   *
   * Every path that drops a message — a budget timeout, a full queue, an unknown monitor,
   * a pool reset — has the id in scope, and none of them used to send it. The client was
   * left holding a `messageId` whose chip said "queued" and a disembodied error string it
   * could not connect to it, so the chip stayed queued forever. An error that kills a
   * message names it.
   */
  messageId?: string;
}

/**
 * Something the provider said about trouble that did **not** end the turn.
 *
 * The sibling of {@link ErrorEvent}, and deliberately not the same event. `ERROR`
 * is an obituary: the client sets `connectionError` from it and, when it names a
 * `messageId`, marks that message failed and stops redelivering it. A Claude
 * `rate_limit` or a 529 retry is none of those things — the CLI backs off and
 * answers a moment later — so routing them through `ERROR` would have reported a
 * dead turn that was in fact still running.
 *
 * What it carries is a rendered sentence plus the provider's own `code`, so a
 * consumer can react to `authentication_failed` without matching on English.
 * Producers: `StreamToEventMapper`, from `StreamMessage.type === 'notice'`.
 */
export interface AgentNoticeEvent {
  type: typeof ServerEventType.AGENT_NOTICE;
  /** `warning` — a real problem the user may need to act on. `info` — bookkeeping. */
  level: 'info' | 'warning';
  /** Human-readable, already assembled by the provider's mapper. */
  text: string;
  /** The provider's discriminant, e.g. `rate_limit`, `api_retry`, `permission_denied`. */
  code?: string;
  agentId?: string;
  monitorId?: string;
}

export interface WindowAgentStatusEvent {
  type: typeof ServerEventType.WINDOW_AGENT_STATUS;
  windowId: string;
  agentId: string;
  status: 'assigned' | 'active' | 'released';
}

export interface MessageAcceptedEvent {
  type: typeof ServerEventType.MESSAGE_ACCEPTED;
  messageId: string;
  agentId: string;
}

export interface MessageQueuedEvent {
  type: typeof ServerEventType.MESSAGE_QUEUED;
  messageId: string;
  position: number;
}

export interface ApprovalRequestEvent {
  type: typeof ServerEventType.APPROVAL_REQUEST;
  dialogId: string;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  permissionOptions?: PermissionOptions;
  /** Structured capability rows; `message` remains the fallback. See `CapabilityLine`. */
  capabilities?: CapabilityLine[];
  agentId?: string;
}

export interface AppProtocolRequestEvent {
  type: typeof ServerEventType.APP_PROTOCOL_REQUEST;
  requestId: string;
  windowId: string;
  request: AppProtocolRequest;
  /**
   * How long the server is prepared to wait for this request.
   *
   * The frontend runs its own timer over the postMessage round-trip, and without this it
   * used a fixed 5s — so the server's timeout was decorative. A command that legitimately
   * takes longer (devtools' compile, or a screenshot, whose capture alone may take 5s)
   * came back as "Timeout waiting for app response" no matter what the caller asked for.
   */
  timeoutMs?: number;
}

export interface VerbSubscriptionUpdateEvent {
  type: typeof ServerEventType.VERB_SUBSCRIPTION_UPDATE;
  windowId: string;
  subscriptionId: string;
  uri: string;
}

/**
 * One frame of a stream subscription (`mode: 'stream'`).
 *
 * Where {@link VerbSubscriptionUpdateEvent} is a bare change ping — "this URI's
 * state moved, re-`read()` it" — a stream carries the payload with it. `seq` is
 * monotonic per subscription, so a consumer that sees it jump (8 → 12) *knows*
 * frames were dropped rather than silently rendering a hole. `kind` is
 * source-defined (`'text' | 'thinking' | 'tool' | 'progress' | 'event' | 'done'`
 * …) so a new stream source needs no shared-package change.
 */
export interface StreamFrame {
  /** Source URI (may be more specific than the subscribed prefix). */
  uri: string;
  /** Monotonic per subscription — a gap means frames were dropped. */
  seq: number;
  /** Source-defined frame type. */
  kind: string;
  /** Source-defined JSON payload, size-capped server-side. */
  data: unknown;
  /** Server timestamp (ms). */
  ts: number;
}

export interface StreamFrameEvent {
  type: typeof ServerEventType.STREAM_FRAME;
  windowId: string;
  subscriptionId: string;
  frame: StreamFrame;
}

export interface CliRestoreEntry {
  type: 'user' | 'thinking' | 'response' | 'tool' | 'error' | 'action-summary';
  content: string;
  agentId?: string;
  monitorId: string;
  timestamp: number;
}

export interface CliRestoreEvent {
  type: typeof ServerEventType.CLI_RESTORE;
  entries: CliRestoreEntry[];
}

/** A virtual desktop. Owned by the session, not by a tab. */
export interface MonitorInfo {
  id: string;
  label: string;
}

/**
 * The session's monitor list — authoritative, replacing whatever the client holds.
 *
 * Sent on attach and on every change. `focus` is set only for the connection whose
 * ADD_MONITOR produced this list: it is that tab's answer to "which id did I get?",
 * and it is why the id can be minted server-side without a request/response pairing.
 */
export interface MonitorsEvent {
  type: typeof ServerEventType.MONITORS;
  monitors: MonitorInfo[];
  focus?: string;
}

/** An agent the server considers to be running right now. */
export interface ActiveAgentSnapshot {
  agentId: string;
  status: string;
  monitorId?: string;
}

/**
 * Everything the server currently holds for this session — and, by omission, everything
 * it does not.
 *
 * This is a **replace-state** snapshot, not an additive one. The old reconnect path
 * re-sent `window.create` for each live window and left the client to merge, which meant
 * a window an agent closed while the socket was down stayed on screen forever, and a
 * spinner for an agent that had long since finished ran until the tab was reloaded. The
 * client applies this by *replacing* each surface it covers: any window, notification,
 * dialog, prompt, or active agent not named here is gone.
 *
 * `actions` re-materializes the live surfaces as the actions that would have created them
 * (`window.create`, `notification.show`, `dialog.confirm`, `user.prompt.show`), so the
 * client renders them through the same reducer as live traffic rather than a parallel
 * "restore" path that drifts.
 *
 * What is deliberately *not* here: message status. The client's outbox is the truth about
 * what it sent, and it resends on reconnect (the server dedups by message id), so status
 * is rebuilt from the acks that come back rather than guessed at here.
 */
export interface SnapshotEvent {
  type: typeof ServerEventType.SNAPSHOT;
  actions: OSAction[];
  agents: ActiveAgentSnapshot[];
}

export type ServerEvent =
  | ActionsEvent
  | SnapshotEvent
  | AgentThinkingEvent
  | AgentResponseEvent
  | SessionAttachedEvent
  | ConnectionStatusEvent
  | ToolProgressEvent
  | ErrorEvent
  | AgentNoticeEvent
  | WindowAgentStatusEvent
  | MessageAcceptedEvent
  | MessageQueuedEvent
  | ApprovalRequestEvent
  | AppProtocolRequestEvent
  | VerbSubscriptionUpdateEvent
  | StreamFrameEvent
  | CliRestoreEvent
  | MonitorsEvent;

/**
 * Compile-time drift check between `ServerEventType` (the table) and `ServerEvent` (the
 * union of interfaces) — the server-side mirror of the check in `client.ts`. Drift here
 * becomes a type error at the union/table declaration site instead of a runtime
 * `default:` fallthrough wherever a consumer switches on `.type`.
 */

// Every key in the table must be reachable as some ServerEvent['type'].
type _NoOrphanServerEventTypes =
  Exclude<(typeof ServerEventType)[keyof typeof ServerEventType], ServerEvent['type']> extends never
    ? true
    : ['server event type with no interface'];

// Every ServerEvent member's `type` must be a key in the table.
type _NoOrphanServerEvents =
  Exclude<ServerEvent['type'], (typeof ServerEventType)[keyof typeof ServerEventType]> extends never
    ? true
    : ['server event interface with no type in ServerEventType'];
