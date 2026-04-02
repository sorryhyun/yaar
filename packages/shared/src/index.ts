export * from './actions.js';
export * from './events.js';
export * from './components.js';
export * from './app-protocol.js';

/** Unique session identifier. */
export type SessionId = string;

/** Monitor identifier (e.g., '0'). */
export type MonitorId = string;

/** Default monitor ID. */
export const DEFAULT_MONITOR_ID = '0';
export {
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
  parseFileUri,
  buildFileUri,
  type ParsedBareWindowUri,
  parseBareWindowUri,
  isBareWindowsAuthority,
  expandBraceUri,
} from './yaar-uri.js';
