/**
 * Event type constants and the queue-bypass predicates derived from them.
 *
 * This module intentionally holds no event *interfaces* — see `client.ts` and `server.ts` for
 * those. It exists so both of those modules (and anything else classifying an event by type
 * string) can depend on the tables without depending on each other.
 */

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
