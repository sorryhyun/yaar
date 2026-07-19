/**
 * Verb subscription delivery — pushes change pings and stream frames into the iframe that
 * subscribed. The iframe SDK dispatches on `subscriptionId`.
 */
import type { StreamFrame } from '@yaar/shared';
import { postToIframe, resolveTargetIframe } from './target';

/**
 * Forward a verb subscription update to the target iframe via postMessage.
 * The iframe SDK listens for 'yaar:subscription-update' messages and
 * invokes the registered callback for the matching subscriptionId.
 */
export function handleVerbSubscriptionUpdate(
  windowId: string,
  subscriptionId: string,
  uri: string,
): void {
  const iframe = resolveTargetIframe(windowId);
  if (!iframe) return;

  postToIframe(iframe, {
    type: 'yaar:subscription-update',
    subscriptionId,
    uri,
  });
}

/**
 * Deliver one stream frame to the subscribing iframe.
 *
 * Mirror of {@link handleVerbSubscriptionUpdate} — same window resolution — but
 * carries the whole frame payload instead of a bare change ping.
 */
export function handleStreamFrame(
  windowId: string,
  subscriptionId: string,
  frame: StreamFrame,
): void {
  const iframe = resolveTargetIframe(windowId);
  if (!iframe) return;

  postToIframe(iframe, {
    type: 'yaar:stream-frame',
    subscriptionId,
    frame,
  });
}
