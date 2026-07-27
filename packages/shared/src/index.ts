export * from './actions.js';
export * from './events.js';
export * from './app-protocol.js';

// The Component DSL and the extension bridge both carry Zod schemas. The barrel exposes only
// their Zod-free half — value lists, narrow types, guards — plus type-only re-exports of what
// the schemas infer. The schemas themselves live behind `@yaar/shared/schemas`, so importing
// this barrel from the browser does not bundle Zod. See `schemas.ts`.
export * from './component-types.js';
export type { ComponentLayout, DisplayContent } from './components.js';
export type {
  BridgeTab,
  BridgeHello,
  BridgeTabs,
  BridgeCommandAction,
  BridgeCommand,
  BridgeContent,
  BridgeCommandResult,
  BridgeActivity,
  BridgeEventChannel,
  BridgeEvent,
  BridgeMessage,
  BridgeServerMessage,
  BridgeFidelity,
} from './bridge.js';

/** Unique session identifier. */
export type SessionId = string;

/** Monitor identifier (e.g., '0'). */
export type MonitorId = string;

/** Default monitor ID. */
export const DEFAULT_MONITOR_ID = '0';

/**
 * Maximum monitors per session.
 *
 * Shared because the server now mints monitor ids and enforces this, while the frontend
 * still hides the "add monitor" button at the cap. Two copies of the number is how the
 * client offered a monitor the server would refuse.
 */
export const MAX_MONITORS = 4;
export {
  IFRAME_IME_GUARD_SCRIPT,
  IFRAME_CAPTURE_HELPER_SCRIPT,
  IFRAME_STORAGE_SDK_SCRIPT,
  IFRAME_FETCH_PROXY_SCRIPT,
  IFRAME_CONTEXTMENU_SCRIPT,
  IFRAME_NOTIFICATIONS_SDK_SCRIPT,
  IFRAME_WINDOWS_SDK_SCRIPT,
  IFRAME_VERB_SDK_SCRIPT,
  IFRAME_APP_PROTOCOL_SCRIPT,
  IFRAME_CONSOLE_CAPTURE_SCRIPT,
} from './iframe-scripts/index.js';
export {
  type YaarAuthority,
  type ParsedYaarUri,
  type ParsedFileUri,
  parseYaarUri,
  buildYaarUri,
  isYaarUri,
  resolveContentUri,
  extractAppId,
  PREVIEW_APP_PREFIX,
  previewAppId,
  isPreviewAppId,
  parseFileUri,
  type ParsedBareWindowUri,
  parseBareWindowUri,
  expandBraceUri,
} from './yaar-uri.js';
export * from './design/index.js';
