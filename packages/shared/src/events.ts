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
  CLI_RESTORE: 'CLI_RESTORE',
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
  APP_PROTOCOL_RESPONSE: 'APP_PROTOCOL_RESPONSE',
  APP_PROTOCOL_READY: 'APP_PROTOCOL_READY',
  APP_EVENT: 'APP_EVENT',
  SUBSCRIBE_MONITOR: 'SUBSCRIBE_MONITOR',
  REMOVE_MONITOR: 'REMOVE_MONITOR',
} as const;

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
   * Set from the CLI-panel Monitor/Session toggle. See
   * docs/session_agent_browser_design.md §6.
   */
  target?: 'monitor' | 'session';
}

export interface WindowMessageEvent {
  type: typeof ClientEventType.WINDOW_MESSAGE;
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
}

/**
 * Client → Server: an app emitted on a declared event channel (`app.emit(...)`).
 * The server matches subscribers and either wakes the subscribing agent or
 * buffers the event into its next turn. See docs/app_events_subscribe_proposal.md.
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

export interface RemoveMonitorEvent {
  type: typeof ClientEventType.REMOVE_MONITOR;
  monitorId: string;
}

export type ClientEvent =
  | UserMessageEvent
  | WindowMessageEvent
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
  | RemoveMonitorEvent;

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
  status: 'running' | 'complete' | 'error';
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
}

export interface VerbSubscriptionUpdateEvent {
  type: typeof ServerEventType.VERB_SUBSCRIPTION_UPDATE;
  windowId: string;
  subscriptionId: string;
  uri: string;
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

export type ServerEvent =
  | ActionsEvent
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
  | CliRestoreEvent;
