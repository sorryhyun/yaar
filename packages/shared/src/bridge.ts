/**
 * YAAR Bridge — WebSocket message contract between the companion extension and the server.
 *
 * The extension (see `extension/`) dials out to `ws://localhost:{PORT}/bridge` and speaks these
 * messages. Because an installed extension may be older than the server, this is a *public-ish*
 * contract: the handshake is versioned (`BRIDGE_PROTOCOL_VERSION`) and the server checks it.
 *
 * Slice 1 covers T1 (Observe): `hello` + `tabs` (extension → server).
 * Slice 2 adds T2 (Manage): `command` + `activity` (server → extension) and `command-result`
 * (extension → server). See `0607plan.md` and `docs/extension_bridge_proposal.md`.
 */

import { z } from 'zod';

/** Bumped whenever the message shape changes. Server warns on read mismatch, refuses commands. */
export const BRIDGE_PROTOCOL_VERSION = 2;

/**
 * Minimum extension protocol version that can execute T2 commands (focus/close/group/move).
 * A v1 extension still feeds tabs fine (T1), but can't act — `sendCommand` refuses below this.
 */
export const BRIDGE_COMMAND_MIN_VERSION = 2;

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

// ── T2 (Manage): command frames flow server → extension, results flow back ──

/** The window-manager verbs YAAR can invoke on a real tab. */
export const bridgeCommandActionSchema = z.enum(['focus', 'close', 'group', 'move']);
export type BridgeCommandAction = z.infer<typeof bridgeCommandActionSchema>;

/**
 * A command from the server for the extension to execute against a real tab.
 * `requestId` correlates the eventual `command-result`. Extra fields are action-specific:
 * `tabIds`/`groupTitle` for `group`, `index`/`windowId` for `move`.
 */
export const bridgeCommandSchema = z.object({
  type: z.literal('command'),
  requestId: z.number(),
  action: bridgeCommandActionSchema,
  tabId: z.number().describe('The primary target tab id'),
  tabIds: z.array(z.number()).optional().describe('group: tabs to include (defaults to [tabId])'),
  groupTitle: z.string().optional().describe('group: optional label for the new tab group'),
  index: z.number().optional().describe('move: destination index within the window'),
  windowId: z.number().optional().describe('move: destination window id'),
});
export type BridgeCommand = z.infer<typeof bridgeCommandSchema>;

/** The extension's reply to a `command`, correlated by `requestId`. */
export const bridgeCommandResultSchema = z.object({
  type: z.literal('command-result'),
  requestId: z.number(),
  ok: z.boolean(),
  error: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type BridgeCommandResult = z.infer<typeof bridgeCommandResultSchema>;

/**
 * A "YAAR is touching your browser" cue — the extension paints a transient cursor/tracking
 * overlay on the target tab (or the active tab when `tabId` is absent). Fire-and-forget:
 * purely cosmetic, never blocks or mutates page content.
 */
export const bridgeActivitySchema = z.object({
  type: z.literal('activity'),
  kind: z.enum(['act', 'observe']).describe("'act' = a mutation is firing; 'observe' = watching"),
  tabId: z.number().optional().describe('Target tab; falls back to the active tab when omitted'),
  action: z.string().optional().describe('The verb driving this activity, for the overlay label'),
  label: z.string().describe('Human-readable overlay text, e.g. "YAAR · focus"'),
});
export type BridgeActivity = z.infer<typeof bridgeActivitySchema>;

/** Any inbound frame from the extension (extension → server). */
export const bridgeMessageSchema = z.discriminatedUnion('type', [
  bridgeHelloSchema,
  bridgeTabsSchema,
  bridgeCommandResultSchema,
]);
export type BridgeMessage = z.infer<typeof bridgeMessageSchema>;

/** Any outbound frame to the extension (server → extension). */
export const bridgeServerMessageSchema = z.discriminatedUnion('type', [
  bridgeCommandSchema,
  bridgeActivitySchema,
]);
export type BridgeServerMessage = z.infer<typeof bridgeServerMessageSchema>;

/** How a `yaar://browser/*` feed was produced — lets UIs show what's available. */
export type BridgeFidelity = 'os-signals' | 'bridge';
