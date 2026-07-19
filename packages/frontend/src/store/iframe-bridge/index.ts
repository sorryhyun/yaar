/**
 * Iframe Bridge - all communication between the desktop store and iframe windows.
 *
 * Covers: window capture (direct WS send), App Protocol relay, verb subscription
 * forwarding, iframe message routing, windows SDK handler, and notification broadcasting.
 *
 * This barrel is the bridge's only entry point — `import ... from '@/store/iframe-bridge'`
 * (or via `@/store`). The modules beside it are internal ownership boundaries, not a set of
 * public subpath imports. `store-access.ts` is the single module aware of `desktop.ts`;
 * everything else takes the store through it, so the (deliberate, runtime-only) cycle
 * between the store and the bridge stays confined to one file.
 */
export { tryIframeSelfCapture, captureWindow } from './capture';
export {
  resendAppProtocolReady,
  notifyIframeClose,
  handleAppProtocolRequest,
} from './app-protocol-relay';
export { handleVerbSubscriptionUpdate, handleStreamFrame } from './subscription-relay';
export {
  getIframeDragSource,
  consumeIframeDragSource,
  initIframeMessageHandlers,
} from './app-events';
export { initWindowsSdkHandler } from './windows-sdk';
export { initNotificationBroadcaster } from './notifications';
