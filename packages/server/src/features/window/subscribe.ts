/**
 * Window subscription handlers for agent-level pub/sub.
 *
 * Allows agents to subscribe to window changes and receive synthetic
 * notifications when the target window is modified.
 */

import type { VerbResult } from '../../handlers/uri-registry.js';
import { okJson, error } from '../../handlers/utils.js';
import { getAgentId, getMonitorId } from '../../agents/session.js';
import { getActivePool } from '../../handlers/utils.js';
import { WINDOW_CHANGE_EVENTS, type WindowChangeEvent } from '@yaar/shared';
import { requireWindowExists } from './helpers.js';
import type { WindowStateRegistry } from '../../session/window-state.js';

export function handleSubscribe(
  windowState: WindowStateRegistry,
  windowId: string,
  payload: Record<string, unknown>,
): VerbResult {
  const exists = requireWindowExists(windowState, windowId);
  if (exists) return exists;

  const pool = getActivePool();
  if (!pool) return error('Session not initialized.');

  const agentId = getAgentId();
  const monitorId = getMonitorId() ?? '0';
  if (!agentId) return error('No agent context — subscribe must be called from an agent.');

  // Determine subscriber type and key from agentId pattern
  // Main agents: "main-{monitorId}", Window agents: "window-{windowId}" or "window-{windowId}/{actionId}"
  const isWindowAgent = agentId.startsWith('window-');
  const subscriberType = isWindowAgent ? 'window' : 'main';

  // For window agents, extract the window ID (the agentKey used by WindowTaskProcessor)
  let subscriberAgentKey: string;
  let subscriberWindowId: string | undefined;
  if (isWindowAgent) {
    const windowPart = agentId.replace(/^window-/, '').replace(/\/.*$/, '');
    subscriberAgentKey = windowPart;
    subscriberWindowId = windowPart;
  } else {
    subscriberAgentKey = `main-${monitorId}`;
  }

  // Parse events from payload
  const rawEvents = payload.events;
  let events: WindowChangeEvent[];
  if (Array.isArray(rawEvents)) {
    events = rawEvents.filter((e): e is WindowChangeEvent =>
      (WINDOW_CHANGE_EVENTS as readonly string[]).includes(e as string),
    );
  } else {
    events = ['content', 'interaction', 'close'];
  }

  if (events.length === 0) return error('No valid events specified.');

  const debounceMs =
    typeof payload.debounceMs === 'number'
      ? Math.max(100, Math.min(5000, payload.debounceMs))
      : undefined;

  const subscriptionId = pool.windowSubscriptionPolicy.subscribe({
    subscriberAgentKey,
    subscriberType,
    subscriberWindowId,
    subscriberMonitorId: monitorId,
    targetWindowId: windowId,
    events,
    debounceMs,
  });

  return okJson({ subscriptionId, targetWindowId: windowId, events });
}

export function handleUnsubscribe(payload: Record<string, unknown>): VerbResult {
  const pool = getActivePool();
  if (!pool) return error('Session not initialized.');

  const subscriptionId = payload.subscriptionId;
  if (typeof subscriptionId !== 'string') return error('Missing subscriptionId.');

  const removed = pool.windowSubscriptionPolicy.unsubscribe(subscriptionId);
  if (!removed) return error(`Subscription "${subscriptionId}" not found.`);

  return okJson({ unsubscribed: subscriptionId });
}
