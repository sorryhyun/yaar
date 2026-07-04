/**
 * YAAR Bridge WebSocket handlers.
 *
 * The companion browser extension (see `extension/`) dials OUT to `ws://localhost:{PORT}/bridge`
 * whenever a YAAR server is up. These handlers validate its frames and feed them into `BridgeHub`,
 * which backs the read-only `yaar://browser/*` verb surface (T1 Observe). No page-content access,
 * no tab management yet — those are Slice 2. See `0607plan.md`.
 *
 * Dispatched from `createWsHandlers` in `server.ts` when `ws.data.kind === 'bridge'`.
 */

import type { ServerWebSocket } from 'bun';
import type { WsData } from './server.js';
import { bridgeMessageSchema, BRIDGE_PROTOCOL_VERSION } from '@yaar/shared';
import { getBridgeHub } from '../features/browser/bridge.js';

export function handleBridgeOpen(ws: ServerWebSocket<WsData>): void {
  console.log(`[bridge] extension connected: ${ws.data.connectionId}`);
}

export function handleBridgeMessage(ws: ServerWebSocket<WsData>, data: string | Buffer): void {
  let raw: unknown;
  try {
    raw = JSON.parse(typeof data === 'string' ? data : data.toString());
  } catch {
    console.warn('[bridge] dropped non-JSON frame');
    return;
  }

  const parsed = bridgeMessageSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn('[bridge] dropped invalid frame:', parsed.error.issues[0]?.message ?? 'unknown');
    return;
  }
  const msg = parsed.data;
  const hub = getBridgeHub();

  switch (msg.type) {
    case 'hello': {
      const { name, version } = msg.browser;
      if (msg.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
        console.warn(
          `[bridge] protocol mismatch: extension v${msg.protocolVersion}, ` +
            `server v${BRIDGE_PROTOCOL_VERSION} (${name} ${version}) — accepting; may misbehave`,
        );
      }
      hub.setConnection({ browser: msg.browser, protocolVersion: msg.protocolVersion });
      console.log(
        `[bridge] hello from ${name} ${version} — protocol v${msg.protocolVersion}, ${msg.tabCount} tabs`,
      );
      return;
    }
    case 'tabs': {
      hub.updateTabs(msg.tabs);
      console.log(`[bridge] tabs update: ${msg.tabs.length} tabs`);
      return;
    }
  }
}

export function handleBridgeClose(ws: ServerWebSocket<WsData>): void {
  getBridgeHub().clearConnection();
  console.log(`[bridge] extension disconnected: ${ws.data.connectionId}`);
}
