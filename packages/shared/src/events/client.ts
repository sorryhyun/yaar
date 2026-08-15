/**
 * Client → Server WebSocket event interfaces and the discriminated union over them.
 */

import type { AppProtocolResponse } from '../app-protocol.js';
import { ClientEventType } from './routing.js';

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
  /**
   * The monitor whose context to clear. A reset is issued from one desktop's command
   * palette, so it means *this* desktop: its agent tree, its queue, its timeline, its
   * branch of the tape. Everything on the other monitors keeps running.
   *
   * Omitted means the whole session — the original behavior, still what a caller with
   * no monitor in hand gets.
   */
  monitorId?: string;
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
  /**
   * What a *successful* `renderer: 'capture'` feedback left out of the image.
   *
   * A composite capture can drop real content and still return a plausible
   * picture — a canvas it could not read, an image it could not inline, or a
   * failed composite rescued by the largest-canvas fallback, which returns one
   * canvas and none of the surrounding DOM. Each of those used to arrive as an
   * unqualified success, so a screenshot taken to check a region could show that
   * region empty and be believed. Absent when the capture drew everything.
   */
  captureDegraded?: string[];
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

/**
 * An image lifted off the clipboard, already sized to the request's ceilings.
 *
 * `width`/`height` are the image's *natural* size, before any downscale, so a caller can
 * tell a thumbnail of a 4K screenshot from a 200px avatar that arrived untouched — the
 * base64 alone cannot say which it is looking at.
 */
export interface ClipboardImagePayload {
  /** Base64 bytes, no `data:` prefix — same shape as `RenderingFeedbackEvent.imageData`. */
  data: string;
  mimeType: string;
  /** Decoded size in bytes. What the image costs, not what its base64 spelling costs. */
  bytes: number;
  width: number;
  height: number;
  /** The desktop re-encoded it smaller to fit `maxImagePx`/`maxImageBytes`. */
  downscaled?: boolean;
}

/**
 * The desktop's answer to a `user.clipboard.read` / `user.clipboard.write`.
 *
 * `reason` is machine-readable because the failures are not interchangeable and the caller
 * has to say something different about each: a denied read is fixed by the user granting
 * clipboard access, an unfocused one by clicking the desktop first, an empty one by
 * copying something. Collapsing them into one "clipboard read failed" is what makes an
 * agent guess.
 */
export interface ClipboardResponseEvent {
  type: typeof ClientEventType.CLIPBOARD_RESPONSE;
  requestId: string;
  ok: boolean;
  /** Clipboard text, already trimmed to the request's `maxChars`. */
  text?: string;
  /** True length in characters, present only when `text` is a prefix of it. */
  totalChars?: number;
  truncated?: boolean;
  image?: ClipboardImagePayload;
  reason?: 'denied' | 'not-focused' | 'unsupported' | 'empty' | 'too-large' | 'failed';
  error?: string;
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
  /**
   * Also wake this app's own agent, on top of whatever subscribed. The emitting
   * iframe is the only party that knows whether its agent is waiting on this
   * event — a background task the agent started is worth a wakeup, the same task
   * started by the user from the app's own UI is not — so the decision is made
   * per emit rather than by a standing subscription. Honoured only for an agent
   * that already exists (`WindowEventCoordinator.wakeOwnAppAgent`).
   */
  wakeAgent?: boolean;
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
  | RenderingFeedbackEvent
  | ComponentActionEvent
  | DialogFeedbackEvent
  | ToastActionEvent
  | UserPromptResponseEvent
  | ClipboardResponseEvent
  | UserInteractionEvent
  | AppProtocolResponseEvent
  | AppProtocolReadyEvent
  | AppEventEvent
  | SubscribeMonitorEvent
  | AddMonitorEvent
  | RemoveMonitorEvent
  | ResyncEvent;

/**
 * Compile-time drift check between `ClientEventType` (the table) and `ClientEvent` (the
 * union of interfaces). These two used to agree only by hand — add a key to the table
 * without adding (or wiring up) its interface, or vice versa, and nothing caught it short
 * of a `default:` fallthrough at runtime somewhere downstream. Both directions are
 * asserted below; if either ever produces a non-`never` residue, the named tuple becomes
 * the compiler error, pointing at exactly which side has the orphan.
 */

// Every key in the table must be reachable as some ClientEvent['type'].
type _NoOrphanClientEventTypes =
  Exclude<(typeof ClientEventType)[keyof typeof ClientEventType], ClientEvent['type']> extends never
    ? true
    : ['client event type with no interface'];

// Every ClientEvent member's `type` must be a key in the table.
type _NoOrphanClientEvents =
  Exclude<ClientEvent['type'], (typeof ClientEventType)[keyof typeof ClientEventType]> extends never
    ? true
    : ['client event interface with no type in ClientEventType'];
