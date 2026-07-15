/**
 * streamHub — the producer-facing door for stream subscriptions.
 *
 * A stream *source* (a long-running verb, an agent's token stream, an app event
 * channel) calls {@link publishFrame} to push a typed frame at whoever subscribed
 * to its URI with `mode: 'stream'`. Delivery, per-subscription `seq`, the payload
 * cap and the `kinds` filter all live in the {@link subscriptionRegistry}; this
 * module is a thin, dependency-light seam so producers in `features/` don't reach
 * up into `http/`.
 *
 * As more sources land (the agent stream, app-channel fan-out), a source
 * *registry* — URI pattern → attach function — belongs next to this file. For now
 * there is one hardcoded producer (deploy progress) that just calls `publishFrame`.
 */

import { subscriptionRegistry } from '../http/subscriptions.js';

/**
 * Publish one frame to stream subscribers of `uri`.
 *
 * @param uri     source URI (subscribers may watch a prefix of it)
 * @param kind    source-defined frame kind (`'progress' | 'done' | 'error' | …`)
 * @param data    JSON payload, size-capped by the registry
 * @param sessionId scope the frame to one session (omit only for session-independent sources)
 */
export function publishFrame(uri: string, kind: string, data: unknown, sessionId?: string): void {
  subscriptionRegistry.publishFrame(uri, kind, data, sessionId);
}
