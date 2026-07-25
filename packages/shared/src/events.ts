/**
 * WebSocket event types for client-server communication.
 */

import type { OSAction, PermissionOptions } from './actions.js';
import type { AppProtocolRequest, AppProtocolResponse } from './app-protocol.js';

// ============ Shared Tool Names ============

/** Canonical tool name for subagent lifecycle events. Providers map their native names to this. */
export const SUBAGENT_TOOL_NAME = 'subagent' as const;

// ============ Event Type Constants ============

/** Server → Client event type discriminants. */
export const ServerEventType = {
  ACTIONS: 'ACTIONS',
  AGENT_THINKING: 'AGENT_THINKING',
  AGENT_RESPONSE: 'AGENT_RESPONSE',
  SESSION_ATTACHED: 'SESSION_ATTACHED',
  CONNECTION_STATUS: 'CONNECTION_STATUS',
  TOOL_PROGRESS: 'TOOL_PROGRESS',
  ERROR: 'ERROR',
  WINDOW_AGENT_STATUS: 'WINDOW_AGENT_STATUS',
  MESSAGE_ACCEPTED: 'MESSAGE_ACCEPTED',
  MESSAGE_QUEUED: 'MESSAGE_QUEUED',
  APPROVAL_REQUEST: 'APPROVAL_REQUEST',
  APP_PROTOCOL_REQUEST: 'APP_PROTOCOL_REQUEST',
  VERB_SUBSCRIPTION_UPDATE: 'VERB_SUBSCRIPTION_UPDATE',
  STREAM_FRAME: 'STREAM_FRAME',
  CLI_RESTORE: 'CLI_RESTORE',
  MONITORS: 'MONITORS',
  SNAPSHOT: 'SNAPSHOT',
} as const;

/** Client → Server event type discriminants. */
export const ClientEventType = {
  USER_MESSAGE: 'USER_MESSAGE',
  WINDOW_MESSAGE: 'WINDOW_MESSAGE',
  INTERRUPT: 'INTERRUPT',
  INTERRUPT_AGENT: 'INTERRUPT_AGENT',
  RESET: 'RESET',
  SET_PROVIDER: 'SET_PROVIDER',
  RENDERING_FEEDBACK: 'RENDERING_FEEDBACK',
  COMPONENT_ACTION: 'COMPONENT_ACTION',
  DIALOG_FEEDBACK: 'DIALOG_FEEDBACK',
  TOAST_ACTION: 'TOAST_ACTION',
  USER_PROMPT_RESPONSE: 'USER_PROMPT_RESPONSE',
  USER_INTERACTION: 'USER_INTERACTION',
  APP_INTERACTION: 'APP_INTERACTION',
  APP_PROTOCOL_RESPONSE: 'APP_PROTOCOL_RESPONSE',
  APP_PROTOCOL_READY: 'APP_PROTOCOL_READY',
  APP_EVENT: 'APP_EVENT',
  SUBSCRIBE_MONITOR: 'SUBSCRIBE_MONITOR',
  ADD_MONITOR: 'ADD_MONITOR',
  REMOVE_MONITOR: 'REMOVE_MONITOR',
  RESYNC: 'RESYNC',
} as const;

/**
 * The frames that *answer* something the server is already blocked on.
 *
 * Every one of these resolves a wait held open inside an agent turn — a `PendingStore`
 * entry keyed by `requestId`/`dialogId`/`promptId`, or the app-ready registration a
 * `command` is parked on. The server sends the question and the client answers it on the
 * same socket, which means the answer arrives *behind the frame that is waiting for it*
 * in that connection's queue. So it must overtake: the turn cannot finish until the
 * answer is read, and the answer cannot be read until the turn finishes. That cycle is
 * what made every app command fail with "App did not respond" about an app that had
 * answered in milliseconds. Order against other frames costs these nothing — each is
 * keyed by its own id and nothing downstream reads them as a sequence.
 *
 * This list lives here, next to the event types themselves, because it is not the
 * socket's private knowledge: the socket bypasses the queue for them, `routeMessage`
 * resolves them, and the loopback tests assert one liveness row per entry. A new
 * server→client wait that is not added here is a deadlock waiting to happen — and the
 * table in `loopback-answer-waits.test.ts` iterates this list precisely so that
 * forgetting shows up as a red test rather than as a wedged app.
 */
export const ANSWER_EVENT_TYPES = [
  ClientEventType.APP_PROTOCOL_RESPONSE, // → PendingStore (app query/command)
  ClientEventType.APP_PROTOCOL_READY, // → waitForAppReady, awaited inside a turn
  ClientEventType.RENDERING_FEEDBACK, // → PendingStore (emitActionWithFeedback)
  ClientEventType.DIALOG_FEEDBACK, // → PendingStore (confirm/permission dialogs)
  ClientEventType.USER_PROMPT_RESPONSE, // → PendingStore (user prompts)
] as const;

/** A client frame that answers a pending server-side wait. See ANSWER_EVENT_TYPES. */
export type AnswerEventType = (typeof ANSWER_EVENT_TYPES)[number];

const ANSWER_EVENTS: ReadonlySet<string> = new Set<string>(ANSWER_EVENT_TYPES);

/** Does this frame answer a wait the server is holding open? See ANSWER_EVENT_TYPES. */
export function isAnswerEvent(type: string): boolean {
  return ANSWER_EVENTS.has(type);
}

/**
 * The frames that control the session rather than talk to it.
 *
 * These overtake the connection queue for a different reason than ANSWER_EVENT_TYPES:
 * not because something is blocked on them, but because they have no ordering
 * relationship with the frames in front of them and the frames in front of them can
 * take a very long time. `routeOne` awaits `routeMessage`, and a `USER_MESSAGE` that
 * finds its monitor agent idle is processed *inline* — so that frame holds the head of
 * the queue for the entire streaming turn. Everything behind it waits out the turn.
 *
 * That made the `+` monitor button feel dead for seconds at a time: adding a monitor is
 * a synchronous push onto `LiveSession.monitors`, but it was queued behind a model that
 * was still thinking. Interrupt was worse than slow — an `INTERRUPT` parked behind the
 * turn it means to cancel cannot arrive until that turn has already finished.
 *
 * The safety argument is per-entry, not general: each handler here touches only
 * session/connection-level state (the monitor list, this connection's subscription, an
 * agent's cancel signal) and never enters `ContextPool`'s task queues, so no frame it
 * overtakes reads its effect as a sequence. They stay ordered *among themselves* because
 * their handlers are synchronous and `message()` dispatches them in arrival order.
 *
 * Deliberately absent: `RESYNC`, whose entire contract is "you have now heard everything
 * I said before this" — it is the one frame whose meaning *is* its position in the queue.
 */
export const CONTROL_EVENT_TYPES = [
  ClientEventType.ADD_MONITOR, // → LiveSession.monitors.push
  ClientEventType.REMOVE_MONITOR, // → LiveSession.monitors.filter
  ClientEventType.SUBSCRIBE_MONITOR, // → BroadcastCenter, per-connection
  ClientEventType.INTERRUPT, // → cancels the very turn that would block it
  ClientEventType.INTERRUPT_AGENT, // → same, scoped to one agent
] as const;

/** A client frame that controls the session and carries no queue ordering. */
export type ControlEventType = (typeof CONTROL_EVENT_TYPES)[number];

const CONTROL_EVENTS: ReadonlySet<string> = new Set<string>(CONTROL_EVENT_TYPES);

/** Does this frame control the session rather than queue behind it? See CONTROL_EVENT_TYPES. */
export function isControlEvent(type: string): boolean {
  return CONTROL_EVENTS.has(type);
}

// ============ Client → Server Events ============

export interface UserInteraction {
  type:
    | 'window.create'
    | 'window.close'
    | 'window.focus'
    | 'window.move'
    | 'window.resize'
    | 'window.minimize'
    | 'window.maximize'
    | 'toast.dismiss'
    | 'notification.dismiss'
    | 'icon.click'
    | 'icon.drag'
    | 'selection.action'
    | 'region.select'
    | 'draw';
  timestamp: number;
  windowId?: string;
  windowTitle?: string;
  details?: string;
  instruction?: string; // User instruction for selection.action and region.select
  selectedText?: string; // Selected text for selection.action
  region?: { x: number; y: number; w: number; h: number }; // Region bounds for region.select
  contentHint?: string; // Extracted text within region for region.select
  sourceAppId?: string; // App ID for icon.drag
  imageData?: string; // Base64 PNG for drawings
  bounds?: { x: number; y: number; w: number; h: number };
  monitorId?: string; // Monitor ID for window.create
  content?: { renderer: string; data: unknown }; // Window content for window.create
  appId?: string; // App ID for window.create
}

export interface UserMessageEvent {
  type: typeof ClientEventType.USER_MESSAGE;
  messageId: string;
  content: string;
  interactions?: UserInteraction[];
  monitorId?: string;
  /**
   * Routing target for this message (default `'monitor'`):
   *  - `'monitor'` — the monitor agent (sandbox browsing only). Today's behavior.
   *  - `'session'` — the session agent, the user's deputy, which can drive the
   *    user's real browser via `yaar://session/browser`.
   * Set from the CLI-panel Monitor/Session toggle.
   */
  target?: 'monitor' | 'session';
}

export interface WindowMessageEvent {
  type: typeof ClientEventType.WINDOW_MESSAGE;
  messageId: string;
  windowId: string;
  content: string;
}

/** Semantic app interaction that invokes an idle app agent or steers its active turn. */
export interface AppInteractionEvent {
  type: typeof ClientEventType.APP_INTERACTION;
  messageId: string;
  windowId: string;
  content: string;
}

export interface InterruptEvent {
  type: typeof ClientEventType.INTERRUPT;
}

export interface InterruptAgentEvent {
  type: typeof ClientEventType.INTERRUPT_AGENT;
  agentId: string;
}

export interface ResetEvent {
  type: typeof ClientEventType.RESET;
}

export interface SetProviderEvent {
  type: typeof ClientEventType.SET_PROVIDER;
  provider: 'claude' | 'codex';
}

export interface RenderingFeedbackEvent {
  type: typeof ClientEventType.RENDERING_FEEDBACK;
  requestId: string;
  windowId: string;
  renderer: string;
  success: boolean;
  error?: string;
  url?: string;
  locked?: boolean;
  imageData?: string;
  /**
   * Why a `renderer: 'capture'` feedback carries no image.
   *
   * One of the iframe capture script's reasons ('taint', 'zero-size',
   * 'serialize-error', 'img-load-error', 'no-provider') or 'no-response' when the
   * iframe never answered at all. Absent on success and on non-capture feedback.
   * A failed capture used to be reported as a bare "returned empty", which reads
   * the same whether the canvas was tainted (retrying is futile) or the page was
   * merely slow (retrying is the fix).
   */
  captureFailure?: string;
}

export interface ComponentActionEvent {
  type: typeof ClientEventType.COMPONENT_ACTION;
  windowId: string;
  windowTitle?: string; // Title of the window containing the component
  action: string;
  actionId?: string; // Unique ID for parallel execution (generated for parallel buttons)
  formData?: Record<string, string | number | boolean>; // Form field values when submitForm is used
  formId?: string; // Form ID when submitForm is used
  componentPath?: string[]; // Path through component tree (e.g., ["Card:Settings", "Form:config", "Button:Save"])
}

export interface DialogFeedbackEvent {
  type: typeof ClientEventType.DIALOG_FEEDBACK;
  dialogId: string;
  confirmed: boolean;
  rememberChoice?: 'once' | 'always' | 'deny_always';
}

export interface ToastActionEvent {
  type: typeof ClientEventType.TOAST_ACTION;
  toastId: string;
  eventId: string;
}

export interface UserPromptResponseEvent {
  type: typeof ClientEventType.USER_PROMPT_RESPONSE;
  promptId: string;
  selectedValues?: string[];
  text?: string;
  dismissed?: boolean;
}

export interface UserInteractionEvent {
  type: typeof ClientEventType.USER_INTERACTION;
  interactions: UserInteraction[];
}

export interface AppProtocolResponseEvent {
  type: typeof ClientEventType.APP_PROTOCOL_RESPONSE;
  requestId: string;
  windowId: string;
  response: AppProtocolResponse;
}

export interface AppProtocolReadyEvent {
  type: typeof ClientEventType.APP_PROTOCOL_READY;
  windowId: string;
  /**
   * The desktop is repeating a registration it already witnessed (on reattach), not
   * reporting a fresh one from the iframe.
   *
   * Readiness lives only in the server's memory, so a restarted server has the window but
   * not the fact that its app registered, and refuses every app_query/app_command against
   * it forever. The desktop re-announces to repair that. But the iframe never remounted —
   * it still holds all the state it had — so this must *not* be mistaken for the
   * reload/remount case, whose whole point is that the app came back empty and its commands
   * need replaying. Replaying them at an app that never forgot them applies them twice.
   */
  reannounce?: boolean;
  /**
   * Canonical names of the commands this registration declares `replay: 'never'` for.
   *
   * The policy rides the handshake rather than being read from `dist/protocol.json`
   * because this frame comes from the registration that is *actually running* in the
   * iframe. A manifest on disk can disagree with it — the app may have been rebuilt, or
   * be a devtools preview of uninstalled source — and the disagreement would be silent
   * and one-sided: the server would replay a command the running app never declared.
   *
   * Delivered on every ready, including the re-registration that triggers the replay, so
   * the list is never stale with respect to the commands being filtered. Absent means the
   * app opted nothing out.
   */
  noReplay?: string[];
}

/**
 * Client → Server: an app emitted on a declared event channel (`app.emit(...)`).
 * The server matches subscribers and either wakes the subscribing agent or
 * buffers the event into its next turn. Its server-side twin is the YAAR Bridge
 * `event` frame (see `bridge.ts`), which lands on the same delivery path.
 */
export interface AppEventEvent {
  type: typeof ClientEventType.APP_EVENT;
  windowId: string;
  channel: string;
  payload: unknown;
  messageId: string;
}

export interface SubscribeMonitorEvent {
  type: typeof ClientEventType.SUBSCRIBE_MONITOR;
  monitorId: string;
  /** Desktop viewport dimensions (reported by frontend on subscribe and resize). */
  viewport?: { w: number; h: number };
}

/**
 * Ask the session to create a monitor. The **server** mints the id — two tabs
 * each minting from their own counter is how they collided on one server-side
 * monitor and then could not see each other's. The answer comes back as a
 * `MONITORS` event with `focus` set for the tab that asked.
 */
export interface AddMonitorEvent {
  type: typeof ClientEventType.ADD_MONITOR;
}

export interface RemoveMonitorEvent {
  type: typeof ClientEventType.REMOVE_MONITOR;
  monitorId: string;
}

/**
 * "Tell me what is actually there."
 *
 * The client sends this once it has flushed everything it was holding — the interactions
 * it buffered while the socket was down, the messages in its outbox — and is ready to be
 * overwritten. The server answers with a `SNAPSHOT`, which is authoritative: whatever is
 * not in it does not exist.
 *
 * It comes from the client, after the flush, rather than being pushed at attach time,
 * because the server is only authoritative once it has heard everything the client did
 * while it was away. A snapshot built before the client's buffered `window.create`
 * reached the registry would delete the very window it is reporting.
 */
export interface ResyncEvent {
  type: typeof ClientEventType.RESYNC;
}

export type ClientEvent =
  | UserMessageEvent
  | WindowMessageEvent
  | AppInteractionEvent
  | InterruptEvent
  | InterruptAgentEvent
  | ResetEvent
  | SetProviderEvent
  | RenderingFeedbackEvent
  | ComponentActionEvent
  | DialogFeedbackEvent
  | ToastActionEvent
  | UserPromptResponseEvent
  | UserInteractionEvent
  | AppProtocolResponseEvent
  | AppProtocolReadyEvent
  | AppEventEvent
  | SubscribeMonitorEvent
  | AddMonitorEvent
  | RemoveMonitorEvent
  | ResyncEvent;

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
  | WindowAgentStatusEvent
  | MessageAcceptedEvent
  | MessageQueuedEvent
  | ApprovalRequestEvent
  | AppProtocolRequestEvent
  | VerbSubscriptionUpdateEvent
  | StreamFrameEvent
  | CliRestoreEvent
  | MonitorsEvent;
