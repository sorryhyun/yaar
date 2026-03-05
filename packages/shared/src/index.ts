export * from './actions.js';
export * from './events.js';
export * from './components.js';
export * from './app-protocol.js';

/** Unique session identifier. */
export type SessionId = string;

/** Monitor identifier (e.g., 'monitor-0'). */
export type MonitorId = string;
export {
  IFRAME_CAPTURE_HELPER_SCRIPT,
  IFRAME_STORAGE_SDK_SCRIPT,
  IFRAME_FETCH_PROXY_SCRIPT,
  IFRAME_CONTEXTMENU_SCRIPT,
  IFRAME_NOTIFICATIONS_SDK_SCRIPT,
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
  buildWindowUri,
  parseWindowUri,
  buildWindowResourceUri,
  parseWindowResourceUri,
} from './yaar-uri.js';
