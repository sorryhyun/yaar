/**
 * YAAR Bridge — WebSocket message contract between the companion extension and the server.
 *
 * The extension (see `extension/`) dials out to `ws://localhost:{PORT}/bridge` and speaks these
 * messages. Because an installed extension may be older than the server, this is a *public-ish*
 * contract: the handshake is versioned (`BRIDGE_PROTOCOL_VERSION`) and the server checks it.
 *
 * Slice 1 covers T1 (Observe): `hello` + `tabs`. Slice 2 will add T2 command frames.
 * See `0607plan.md` and `docs/extension_bridge_proposal.md`.
 */

import { z } from 'zod';

/** Bumped whenever the message shape changes. Server warns/refuses on mismatch. */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** Tab-level metadata only — never page content (that boundary is what keeps T1 safe). */
export const bridgeTabSchema = z.object({
  id: z.number().describe('chrome.tabs tab id'),
  url: z.string().describe('Tab URL (may be empty for a loading/blank tab)'),
  title: z.string().describe('Tab title'),
  active: z.boolean().describe('Whether this tab is the active tab in its window'),
  audible: z.boolean().optional().describe('Whether the tab is currently producing sound'),
  windowId: z.number().optional().describe('chrome.windows window id the tab belongs to'),
});
export type BridgeTab = z.infer<typeof bridgeTabSchema>;

/** First frame after connect: identifies the browser and protocol version. */
export const bridgeHelloSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number(),
  browser: z.object({
    name: z.string(),
    version: z.string(),
  }),
  tabCount: z.number(),
});
export type BridgeHello = z.infer<typeof bridgeHelloSchema>;

/** A full snapshot of the current tabs. Slice 1 sends snapshots, not deltas. */
export const bridgeTabsSchema = z.object({
  type: z.literal('tabs'),
  tabs: z.array(bridgeTabSchema),
});
export type BridgeTabs = z.infer<typeof bridgeTabsSchema>;

/** Any inbound frame from the extension. */
export const bridgeMessageSchema = z.discriminatedUnion('type', [
  bridgeHelloSchema,
  bridgeTabsSchema,
]);
export type BridgeMessage = z.infer<typeof bridgeMessageSchema>;

/** How a `yaar://browser/*` feed was produced — lets UIs show what's available. */
export type BridgeFidelity = 'os-signals' | 'bridge';
