/**
 * YAAR Bridge WebSocket handlers.
 *
 * The companion browser extension (see `extension/`) dials OUT to `ws://localhost:{PORT}/bridge`
 * whenever a YAAR server is up. These handlers validate its frames and feed them into `BridgeHub`,
 * which backs the `/api/bridge` surface (driven by the `browser-user` app). T1 (Observe) reads
 * `hello`/`tabs`; T2 (Manage)
 * additionally correlates `command-result` frames back to in-flight `sendCommand` calls. Still no
 * page-content access — that boundary is T3.
 *
 * Dispatched from `createWsHandlers` in `server.ts` when `ws.data.kind === 'bridge'`.
 */

import type { ServerWebSocket } from 'bun';
import type { WsData } from './server.js';
import { bridgeMessageSchema, BRIDGE_PROTOCOL_VERSION } from '@yaar/shared/schemas';
import { getBridgeHub } from '../features/browser/bridge.js';
import { actionEmitter } from '../session/action-emitter.js';
import { createLogger } from '../observability/log.js';

const log = createLogger('bridge');

export function handleBridgeOpen(ws: ServerWebSocket<WsData>): void {
  log.info('extension connected', { connectionId: ws.data.connectionId });
}

export function handleBridgeMessage(ws: ServerWebSocket<WsData>, data: string | Buffer): void {
  let raw: unknown;
  try {
    raw = JSON.parse(typeof data === 'string' ? data : data.toString());
  } catch {
    log.warn('dropped non-JSON frame');
    return;
  }

  const parsed = bridgeMessageSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn('dropped invalid frame', { reason: parsed.error.issues[0]?.message ?? 'unknown' });
    return;
  }
  const msg = parsed.data;
  const hub = getBridgeHub();

  switch (msg.type) {
    case 'hello': {
      const { name, version } = msg.browser;
      if (msg.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
        log.warn('protocol mismatch — accepting; may misbehave', {
          extensionProtocol: msg.protocolVersion,
          serverProtocol: BRIDGE_PROTOCOL_VERSION,
          browser: `${name} ${version}`,
        });
      }
      // Pass the socket so the hub can send T2 commands / activity cues back down it (Slice 2).
      hub.setConnection({ browser: msg.browser, protocolVersion: msg.protocolVersion }, ws);
      log.info('hello from extension', {
        browser: `${name} ${version}`,
        protocol: msg.protocolVersion,
        tabs: msg.tabCount,
      });
      return;
    }
    case 'tabs': {
      hub.updateTabs(msg.tabs);
      log.debug('tabs update', { tabs: msg.tabs.length });
      return;
    }
    case 'command-result': {
      hub.resolveCommand(msg);
      return;
    }
    case 'event': {
      // T4: the extension speaking unprompted. There is exactly one real browser but possibly many
      // live sessions, and the hub is deliberately state-only ("does not push change
      // notifications"), so this fans out through `actionEmitter` — each LiveSession picks it up and
      // delivers it to its own `browser-user` windows. See AppWindowCoordinator.routeBridgeEvent.
      actionEmitter.emit('bridge-event', { channel: msg.channel, payload: msg.payload });
      return;
    }
  }
}

export function handleBridgeClose(ws: ServerWebSocket<WsData>): void {
  getBridgeHub().clearConnection();
  log.info('extension disconnected', { connectionId: ws.data.connectionId });
}
