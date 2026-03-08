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
} from './capture-helper.js';
export { YAAR_DESIGN_TOKENS_CSS } from './design-tokens.js';
export {
  type YaarAuthority,
  type ParsedYaarUri,
  type ParsedContentPath,
  type ParsedFileUri,
  type ParsedWindowUri,
  type ParsedWindowResourceUri,
  type ParsedWindowKey,
  type ConfigSection,
  type ParsedConfigUri,
  type ParsedBrowserUri,
  type ParsedAgentUri,
  type UserResource,
  type ParsedUserUri,
  type SessionResource,
  type ParsedSessionUri,
  parseYaarUri,
  buildYaarUri,
  isYaarUri,
  buildWindowKey,
  parseWindowKey,
  resolveContentUri,
  parseContentPath,
  extractAppId,
  parseFileUri,
  buildFileUri,
  parseMonitorUri,
  buildMonitorUri,
  buildWindowUri,
  parseWindowUri,
  buildWindowResourceUri,
  parseWindowResourceUri,
  parseConfigUri,
  buildConfigUri,
  parseBrowserUri,
  buildBrowserUri,
  parseAgentUri,
  buildAgentUri,
  parseUserUri,
  buildUserUri,
  parseSessionUri,
  buildSessionUri,
  type ParsedBareWindowUri,
  parseBareWindowUri,
  isBareWindowsAuthority,
} from './yaar-uri.js';
