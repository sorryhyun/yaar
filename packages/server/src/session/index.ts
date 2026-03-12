/**
 * Session module — multi-client session support.
 */

export { type SessionId, type SessionSnapshot, generateSessionId } from './types.js';
export { type YaarWebSocket, WS_OPEN } from './types.js';
export { LiveSession, type LiveSessionOptions } from './live-session.js';
export { SessionHub, getSessionHub, initSessionHub } from './session-hub.js';
export {
  BroadcastCenter,
  getBroadcastCenter,
  resetBroadcastCenter,
  generateConnectionId,
  type ConnectionId,
} from './broadcast-center.js';
export { actionEmitter, type ActionEvent, type RenderingFeedback } from './action-emitter.js';
export { WindowStateRegistry, type WindowState } from './window-state.js';
