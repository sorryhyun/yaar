/**
 * MCP messaging tool — DirectMessage.
 *
 * A single addressed messaging primitive shared by all agent roles (app,
 * monitor, session). Generalizes the app agent's `relay` (which could only
 * reach the monitor and always ended the turn) into an addressed send that
 * can target any agent and lets the sender choose whether to yield.
 *
 * Routing reuses the existing task processors — the same paths that back the
 * `relay` tool and `invoke('yaar://windows/{id}', { action: 'message' })`:
 *   - monitor / monitor:{id} → pool.handleTask({ type: 'monitor' })
 *   - app:{appId}            → resolve active window → pool.handleTask({ type: 'app' })
 *   - window:{windowId}      → pool.handleTask({ type: 'app' })
 *   - user                   → showNotification()
 *
 * Delivery is async/notify-only: the tool returns as soon as the message is
 * enqueued. A recipient's reply is just another DirectMessage — we never await
 * another agent's turn inline (that would deadlock on A↔B exchanges).
 *
 * Authority: session/monitor principals may address any target. App principals
 * may always reach `monitor` (their own) and `user`; reaching another app,
 * a specific window, or a foreign monitor requires the app to declare
 * `"messaging": "all"` in its app.json.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getSessionId,
  requireMonitorId,
  getWindowId,
  getAgentRole,
} from '../../agents/agent-context.js';
import { getSessionHub } from '../../session/session-hub.js';
import { getAppMeta } from '../../features/apps/discovery.js';
import { showNotification } from '../../features/user/notifications.js';

export const MESSAGING_TOOL_NAMES = ['mcp__messaging__direct_message'] as const;

type TargetKind = 'monitor' | 'app' | 'window' | 'user';
interface Target {
  kind: TargetKind;
  id?: string;
}

/** Parse a `to` address into a structured target, or null if malformed. */
function parseTarget(to: string): Target | null {
  const t = to.trim();
  if (t === 'user') return { kind: 'user' };
  if (t === 'monitor') return { kind: 'monitor' };
  const sep = t.indexOf(':');
  if (sep === -1) return null;
  const prefix = t.slice(0, sep);
  const id = t.slice(sep + 1).trim();
  if (!id) return null;
  if (prefix === 'monitor') return { kind: 'monitor', id };
  if (prefix === 'app') return { kind: 'app', id };
  if (prefix === 'window') return { kind: 'window', id };
  return null;
}

type RouteResult = { ok: true; text: string } | { ok: false; error: string };

async function routeDirectMessage(to: string, message: string): Promise<RouteResult> {
  const sessionId = getSessionId();
  if (!sessionId) return { ok: false, error: 'no active session.' };
  const session = getSessionHub().get(sessionId);
  const pool = session?.getPool();
  if (!pool || !session) return { ok: false, error: 'no active pool.' };

  const target = parseTarget(to);
  if (!target) {
    return {
      ok: false,
      error: `invalid target "${to}". Use "monitor", "monitor:{id}", "app:{appId}", "window:{id}", or "user".`,
    };
  }

  // ── Sender identity + authority ──
  const role = getAgentRole(); // 'session' | 'monitor' | 'app' | undefined
  const senderMonitorId = requireMonitorId();
  const senderWindowId = getWindowId();
  const senderAppId = senderWindowId
    ? session.windowState.getAppIdForWindow(senderWindowId)
    : undefined;
  const senderLabel = senderAppId
    ? `app:${senderAppId}`
    : role === 'session'
      ? 'session'
      : `monitor:${senderMonitorId}`;

  const privileged = role === 'session' || role === 'monitor';
  const needsAuthority =
    target.kind === 'app' ||
    target.kind === 'window' ||
    (target.kind === 'monitor' && target.id != null && target.id !== senderMonitorId);

  if (!privileged && needsAuthority) {
    if (!senderAppId) {
      return { ok: false, error: `not authorized to message "${to}".` };
    }
    const meta = await getAppMeta(senderAppId);
    if (meta?.messaging !== 'all') {
      return {
        ok: false,
        error:
          `app "${senderAppId}" cannot message "${to}" — it may only reach its own monitor and the user. ` +
          `Add "messaging": "all" to its app.json to grant cross-agent messaging.`,
      };
    }
  }

  const wrap = (content: string) => `<from:${senderLabel}>\n${content}\n</from:${senderLabel}>`;
  const messageId = `dm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  switch (target.kind) {
    case 'user': {
      const n = showNotification({ title: senderLabel, body: message });
      return { ok: true, text: `Notification shown to the user (id: ${n.id}).` };
    }
    case 'monitor': {
      const monitorId = target.id ?? senderMonitorId;
      pool
        .handleTask({ type: 'monitor', messageId, content: wrap(message), monitorId })
        .catch((err: unknown) => console.error('[DirectMessage] monitor route:', err));
      return {
        ok: true,
        text: `Message delivered to monitor "${monitorId}" (messageId: ${messageId}).`,
      };
    }
    case 'app': {
      // App agents are per-monitor: a sender can only reach the copy of the app
      // running on its own monitor.
      const windowId = pool.getActiveAppWindow(senderMonitorId, target.id!);
      if (!windowId) {
        return {
          ok: false,
          error: `app "${target.id}" has no open window on monitor ${senderMonitorId} to receive the message.`,
        };
      }
      pool
        .handleTask({
          type: 'app',
          messageId,
          windowId,
          content: wrap(message),
          monitorId: senderMonitorId,
        })
        .catch((err: unknown) => console.error('[DirectMessage] app route:', err));
      return {
        ok: true,
        text: `Message delivered to app "${target.id}" (window ${windowId}, messageId: ${messageId}).`,
      };
    }
    case 'window': {
      const appId = session.windowState.getAppIdForWindow(target.id!);
      if (!appId) return { ok: false, error: `window "${target.id}" is not an app window.` };
      pool
        .handleTask({
          type: 'app',
          messageId,
          windowId: target.id,
          content: wrap(message),
          monitorId: senderMonitorId,
        })
        .catch((err: unknown) => console.error('[DirectMessage] window route:', err));
      return {
        ok: true,
        text: `Message delivered to window "${target.id}" (app ${appId}, messageId: ${messageId}).`,
      };
    }
  }
}

export function registerMessagingTools(server: McpServer): void {
  server.registerTool(
    'direct_message',
    {
      description:
        'Send an addressed message to another agent or the user. ' +
        'Delivery is asynchronous (fire-and-forget) — the recipient processes it on its own turn; ' +
        "any reply comes back as a separate DirectMessage, so do not expect the recipient's answer in the return value. " +
        'Targets: "monitor" (your monitor), "monitor:{id}", "app:{appId}", "window:{id}", "user" (a notification).',
      inputSchema: {
        to: z
          .string()
          .describe(
            'Target address: "monitor", "monitor:{id}", "app:{appId}", "window:{id}", or "user".',
          ),
        message: z.string().describe('The message content to deliver.'),
        end_turn: z
          .boolean()
          .optional()
          .describe(
            'If true, end your turn after sending (hand-off / delegation). ' +
              'If false or omitted, keep working after sending.',
          ),
      },
    },
    async (args) => {
      const result = await routeDirectMessage(args.to, args.message);
      if (!result.ok) {
        return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      }
      const suffix = args.end_turn ? ' Your turn is complete.' : ' You may continue working.';
      return { content: [{ type: 'text', text: result.text + suffix }] };
    },
  );
}
