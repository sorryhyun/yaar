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
 * Slice 3 adds T3-lite content read: the `extract` command action returns the target tab's page
 * text (via `chrome.scripting`), carried back in `command-result.data`. This is the first frame
 * that crosses the tab-metadata boundary, so it is gated by a distinct per-origin content consent
 * on the server (see `features/browser/guards.ts` `enforceContentReadGuard`). It is named `extract`
 * (matching the CDP `yaar://session/browser` vocabulary) so it never collides with the `read` verb.
 * Slice 5 adds T3 interaction: `click/type/scroll/navigate` *drive* the page (synthetic DOM events
 * via injection, or a tab-URL update for `navigate`) and share the tab-control consent gate; and
 * `screenshot` captures the visible tab as a PNG (content-consent-gated like `extract`). These make
 * the Real Browser app a full driving surface, not just an observe/manage one — still fully
 * app-mediated (never a raw `yaar://browser` verb). See `docs/extension_bridge_proposal.md`.
 * Slice 6 adds T4 (React): the `event` frame, the first thing the extension sends *unprompted* —
 * a native dialog fired on a driven tab, or a driven tab navigated. Until this, the bridge was
 * strictly pull (handshake / snapshot / reply-to-command), so a page that alerted mid-automation
 * simply blocked the tab and the agent learned of it only as an opaque command timeout. These
 * frames land on the `browser-user` app's declared event channels, which agents reach via
 * `app_subscribe` — the same delivery path an in-iframe `app.emit()` uses.
 */

import { z } from 'zod';

/** Bumped whenever the message shape changes. Server warns on read mismatch, refuses commands. */
export const BRIDGE_PROTOCOL_VERSION = 5;

/**
 * Minimum extension protocol version that can execute T2 commands (focus/close/group/move).
 * A v1 extension still feeds tabs fine (T1), but can't act — `sendCommand` refuses below this.
 */
export const BRIDGE_COMMAND_MIN_VERSION = 2;

/**
 * Minimum extension protocol version that can read page content (the `read` action). Higher than
 * the manage floor because content read needs the `scripting` injection path the older extension
 * lacks; `sendCommand` refuses a `read` below this with a clean "update the extension" message.
 */
export const BRIDGE_CONTENT_MIN_VERSION = 3;

/**
 * Minimum extension protocol version that can *drive* a page — the T3 interaction verbs
 * (`click`/`type`/`scroll`/`navigate`/`screenshot`). These synthesize DOM events / capture the tab
 * via `chrome.scripting` + `chrome.tabs`, which older extensions don't implement; `sendCommand`
 * refuses them below this with a clean "update the extension" message.
 */
export const BRIDGE_INTERACT_MIN_VERSION = 4;

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

/**
 * The verbs YAAR can invoke on a real tab.
 *  - `focus/close/group/move` — T2 window-manager verbs.
 *  - `extract` (T3-lite) — returns the tab's page content; separately content-consent-gated.
 *  - `click/type/scroll/navigate` (T3) — *drive* the page (synthetic DOM events via injection, or a
 *    tab-URL update for `navigate`); each is a mutation and shares the tab-control consent gate.
 *  - `screenshot` (T3) — captures the visible tab as a PNG data URL; content-consent-gated like `extract`.
 */
export const bridgeCommandActionSchema = z.enum([
  'focus',
  'close',
  'group',
  'move',
  'extract',
  'click',
  'type',
  'scroll',
  'navigate',
  'screenshot',
]);
export type BridgeCommandAction = z.infer<typeof bridgeCommandActionSchema>;

/**
 * A command from the server for the extension to execute against a real tab.
 * `requestId` correlates the eventual `command-result`. Extra fields are action-specific:
 * `tabIds`/`groupTitle` for `group`, `index`/`windowId` for `move`, `maxChars` for `extract`,
 * `selector` for `click`/`type`/`scroll`, `text`/`submit` for `type`, `deltaY`/`top` for `scroll`,
 * `url` for `navigate`.
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
  maxChars: z
    .number()
    .optional()
    .describe('extract: cap on returned page text length (extension truncates and flags it)'),
  selector: z
    .string()
    .optional()
    .describe('click/type/scroll: CSS selector for the target element'),
  text: z.string().optional().describe('type: text to enter into the selected field'),
  submit: z
    .boolean()
    .optional()
    .describe("type: after entering text, press Enter / submit the field's form"),
  deltaY: z
    .number()
    .optional()
    .describe('scroll: pixels to scroll the window vertically (default 600)'),
  top: z.number().optional().describe('scroll: absolute vertical position to scroll the window to'),
  url: z.string().optional().describe('navigate: destination URL to load in the tab'),
});
export type BridgeCommand = z.infer<typeof bridgeCommandSchema>;

/** Default cap on `extract`-returned page text; the extension truncates and sets `truncated`. */
export const BRIDGE_CONTENT_MAX_CHARS = 100_000;

/** The `data` payload an `extract` command-result carries back (page content of the target tab). */
export const bridgeContentSchema = z.object({
  url: z.string(),
  title: z.string(),
  text: z.string().describe('document.body.innerText of the target tab, possibly truncated'),
  truncated: z.boolean(),
});
export type BridgeContent = z.infer<typeof bridgeContentSchema>;

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

// ── T4 (React): unsolicited event frames flow extension → server ──

/**
 * The channels the extension may push *unprompted*, mirroring the `events` the `browser-user` app
 * declares in its App Protocol registration. Every other extension→server frame is either a
 * handshake, a state snapshot, or a reply to a command the server asked for; these are the only
 * frames the real browser originates on its own.
 *
 * Constraining this to an enum (rather than a free `string`) is what keeps the surface honest: an
 * extension cannot invent a channel no agent could have discovered from the app's manifest.
 */
export const bridgeEventChannelSchema = z.enum(['dialog', 'navigated']);
export type BridgeEventChannel = z.infer<typeof bridgeEventChannelSchema>;

/**
 * The app whose windows a bridge `event` is delivered to. The bridge has no session and no window
 * of its own; `browser-user` is the app that fronts the real browser, so its windows are where the
 * channels above are declared and where agents subscribe. Named here, once, so the server does not
 * scatter the literal through its routing.
 */
export const BRIDGE_APP_ID = 'browser-user';

/**
 * Something happened in the real browser that no agent asked for: a native dialog fired on a driven
 * tab, or a driven tab finished loading a new URL. The server forwards these to subscribers of the
 * matching `browser-user` channel (`app_subscribe`), waking or buffering the agent.
 *
 * `payload` is page-authored data in the `dialog` case — treat it as untrusted text, the same way
 * `extract`ed page content is treated. The extension caps its length before it ever leaves the tab.
 */
export const bridgeEventSchema = z.object({
  type: z.literal('event'),
  channel: bridgeEventChannelSchema,
  payload: z
    .record(z.string(), z.unknown())
    .describe('Channel-specific data; see the app manifest'),
});
export type BridgeEvent = z.infer<typeof bridgeEventSchema>;

/** Any inbound frame from the extension (extension → server). */
export const bridgeMessageSchema = z.discriminatedUnion('type', [
  bridgeHelloSchema,
  bridgeTabsSchema,
  bridgeCommandResultSchema,
  bridgeEventSchema,
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
