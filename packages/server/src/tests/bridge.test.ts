/**
 * Tests for the YAAR Bridge T1 (Observe) + T2 (Manage) + T3-lite (Read) surfaces:
 *  - BridgeHub state transitions + isSelf annotation
 *  - shared message schema round-trip + version constants
 *  - the /api/bridge dispatch layer (`runBridgeAction`): observe (listTabs/presence) + manage
 *  - T2 command transport (requestId correlation, old-extension + disconnect refusal)
 *  - the tab-control + content-read guards (self-target refusal, focus/track are free)
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  bridgeMessageSchema,
  bridgeServerMessageSchema,
  bridgeContentSchema,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_COMMAND_MIN_VERSION,
  BRIDGE_CONTENT_MIN_VERSION,
} from '@yaar/shared';
import { getBridgeHub, type BridgeSocket } from '../features/browser/bridge.js';
import {
  enforceTabControlGuard,
  enforceContentReadGuard,
  isMutatingTabAction,
} from '../features/browser/guards.js';
import { runBridgeAction } from '../features/browser/bridge-actions.js';
import { getPort } from '../config.js';

/** A fake extension socket that records every frame the hub sends. */
function fakeSocket(): { socket: BridgeSocket; sent: any[] } {
  const sent: any[] = [];
  return { socket: { send: (d: string) => sent.push(JSON.parse(d)) }, sent };
}

/** Poll a getter across microtasks until it returns a truthy value (or a small deadline). */
async function waitFor<T>(get: () => T | undefined, tries = 50): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = get();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error('waitFor: value never appeared');
}

/** Connect the hub to a fake socket at the current protocol version + one live tab. */
function connectWithTab(protocolVersion = BRIDGE_PROTOCOL_VERSION) {
  const hub = getBridgeHub();
  const { socket, sent } = fakeSocket();
  hub.setConnection({ browser: { name: 'Chrome', version: '2' }, protocolVersion }, socket);
  hub.updateTabs([{ id: 5, url: 'https://a.com', title: 'A', active: true }]);
  return { hub, sent };
}

describe('bridge message schema', () => {
  it('has a numeric protocol version', () => {
    expect(typeof BRIDGE_PROTOCOL_VERSION).toBe('number');
  });

  it('round-trips a hello frame', () => {
    const parsed = bridgeMessageSchema.safeParse({
      type: 'hello',
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      browser: { name: 'Chrome', version: '138.0' },
      tabCount: 3,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown frame type', () => {
    expect(bridgeMessageSchema.safeParse({ type: 'nope' }).success).toBe(false);
  });

  it('rejects a tabs frame with a malformed tab', () => {
    const parsed = bridgeMessageSchema.safeParse({
      type: 'tabs',
      tabs: [{ id: 'not-a-number', url: 'x', title: 'y', active: true }],
    });
    expect(parsed.success).toBe(false);
  });

  it('round-trips a read command frame and its content payload', () => {
    const cmd = bridgeServerMessageSchema.safeParse({
      type: 'command',
      requestId: 1,
      action: 'extract',
      tabId: 5,
      maxChars: 200,
    });
    expect(cmd.success).toBe(true);
    const content = bridgeContentSchema.safeParse({
      url: 'https://a.com',
      title: 'A',
      text: 'body text',
      truncated: false,
    });
    expect(content.success).toBe(true);
  });
});

describe('BridgeHub', () => {
  beforeEach(() => {
    getBridgeHub().clearConnection();
  });

  it('starts disconnected with os-signals fidelity', () => {
    const hub = getBridgeHub();
    expect(hub.isConnected()).toBe(false);
    expect(hub.getFidelity()).toBe('os-signals');
    expect(hub.getTabs()).toEqual([]);
  });

  it('reports bridge fidelity once connected', () => {
    const hub = getBridgeHub();
    hub.setConnection(
      { browser: { name: 'Chrome', version: '138' }, protocolVersion: 1 },
      { send() {} },
    );
    expect(hub.isConnected()).toBe(true);
    expect(hub.getFidelity()).toBe('bridge');
  });

  it('stores tabs and finds the active one', () => {
    const hub = getBridgeHub();
    hub.updateTabs([
      { id: 1, url: 'https://youtube.com', title: 'YT', active: false },
      { id: 2, url: 'https://github.com', title: 'GH', active: true },
    ]);
    expect(hub.getTabs()).toHaveLength(2);
    expect(hub.getTab(2)?.title).toBe('GH');
    expect(hub.getActiveTab()?.id).toBe(2);
  });

  it("annotates YAAR's own tab with isSelf", () => {
    const hub = getBridgeHub();
    hub.updateTabs([
      { id: 1, url: `http://localhost:${getPort()}/`, title: 'YAAR', active: true },
      { id: 2, url: 'https://example.com', title: 'Ex', active: false },
    ]);
    expect(hub.getTab(1)?.isSelf).toBe(true);
    expect(hub.getTab(2)?.isSelf).toBeUndefined();
  });

  it('clears tabs on disconnect', () => {
    const hub = getBridgeHub();
    hub.setConnection(
      { browser: { name: 'Chrome', version: '1' }, protocolVersion: 1 },
      { send() {} },
    );
    hub.updateTabs([{ id: 1, url: 'x', title: 'x', active: true }]);
    hub.clearConnection();
    expect(hub.getTabs()).toEqual([]);
    expect(hub.isConnected()).toBe(false);
  });
});

describe('runBridgeAction — observe (listTabs / presence)', () => {
  beforeEach(() => getBridgeHub().clearConnection());

  it('lists tabs once connected', async () => {
    const hub = getBridgeHub();
    hub.setConnection(
      { browser: { name: 'Chrome', version: '1' }, protocolVersion: 1 },
      { send() {} },
    );
    hub.updateTabs([{ id: 7, url: 'https://a.com', title: 'A', active: true }]);

    const res = await runBridgeAction('listTabs', {}, undefined);
    expect(res.ok).toBe(true);
    const data = res.data as { fidelity: string; connected: boolean; tabs: Array<{ id: number }> };
    expect(data.fidelity).toBe('bridge');
    expect(data.connected).toBe(true);
    expect(data.tabs).toHaveLength(1);
    expect(data.tabs[0].id).toBe(7);
  });

  it('reports disconnected + empty tabs with no extension', async () => {
    const res = await runBridgeAction('listTabs', {}, undefined);
    expect(res.ok).toBe(true);
    const data = res.data as { connected: boolean; tabs: unknown[] };
    expect(data.connected).toBe(false);
    expect(data.tabs).toEqual([]);
  });

  it('reads the presence summary', async () => {
    const hub = getBridgeHub();
    hub.setConnection(
      { browser: { name: 'Chrome', version: '1' }, protocolVersion: 1 },
      { send() {} },
    );
    hub.updateTabs([{ id: 1, url: 'https://a.com', title: 'A', active: true }]);
    const res = await runBridgeAction('presence', {}, undefined);
    const data = res.data as { fidelity: string; tabCount: number; activeTab: { id: number } };
    expect(data.fidelity).toBe('bridge');
    expect(data.tabCount).toBe(1);
    expect(data.activeTab.id).toBe(1);
  });

  it('rejects an unknown action', async () => {
    const res = await runBridgeAction('explode', {}, undefined);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
  });
});

describe('bridge T2 command schema', () => {
  it('bumped the protocol so commands are gated', () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(BRIDGE_COMMAND_MIN_VERSION);
    expect(BRIDGE_COMMAND_MIN_VERSION).toBeGreaterThanOrEqual(2);
  });

  it('round-trips command + activity server frames', () => {
    expect(
      bridgeServerMessageSchema.safeParse({
        type: 'command',
        requestId: 1,
        action: 'focus',
        tabId: 5,
      }).success,
    ).toBe(true);
    expect(
      bridgeServerMessageSchema.safeParse({ type: 'activity', kind: 'act', label: 'YAAR · focus' })
        .success,
    ).toBe(true);
  });

  it('accepts a command-result as an inbound frame', () => {
    expect(
      bridgeMessageSchema.safeParse({ type: 'command-result', requestId: 1, ok: true }).success,
    ).toBe(true);
  });

  it('rejects an unknown command action', () => {
    expect(
      bridgeServerMessageSchema.safeParse({
        type: 'command',
        requestId: 1,
        action: 'nuke',
        tabId: 5,
      }).success,
    ).toBe(false);
  });
});

describe('BridgeHub.sendCommand', () => {
  beforeEach(() => getBridgeHub().clearConnection());

  it('sends a command frame and resolves on the correlated result', async () => {
    const { hub, sent } = connectWithTab();
    const p = hub.sendCommand({ action: 'focus', tabId: 5 });
    const frame = sent.find((f) => f.type === 'command');
    expect(frame).toBeTruthy();
    expect(frame.action).toBe('focus');
    expect(typeof frame.requestId).toBe('number');

    hub.resolveCommand({ type: 'command-result', requestId: frame.requestId, ok: true });
    expect(await p).toEqual({ ok: true, data: undefined });
  });

  it('correlates concurrent commands by requestId', async () => {
    const { hub, sent } = connectWithTab();
    const p1 = hub.sendCommand({ action: 'focus', tabId: 5 });
    const p2 = hub.sendCommand({ action: 'close', tabId: 5 });
    const [f1, f2] = sent.filter((f) => f.type === 'command');
    expect(f1.requestId).not.toBe(f2.requestId);

    // Resolve out of order — each promise gets its own result.
    hub.resolveCommand({
      type: 'command-result',
      requestId: f2.requestId,
      ok: false,
      error: 'nope',
    });
    hub.resolveCommand({ type: 'command-result', requestId: f1.requestId, ok: true });
    expect(await p1).toEqual({ ok: true, data: undefined });
    expect(await p2).toEqual({ ok: false, error: 'nope' });
  });

  it('refuses when no extension is connected', async () => {
    const outcome = await getBridgeHub().sendCommand({ action: 'focus', tabId: 1 });
    expect(outcome.ok).toBe(false);
  });

  it('refuses commands from an extension older than the command floor', async () => {
    const { hub } = connectWithTab(BRIDGE_COMMAND_MIN_VERSION - 1);
    const outcome = await hub.sendCommand({ action: 'focus', tabId: 5 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('too old');
  });

  it('fails in-flight commands on disconnect', async () => {
    const { hub } = connectWithTab();
    const p = hub.sendCommand({ action: 'focus', tabId: 5 });
    hub.clearConnection();
    const outcome = await p;
    expect(outcome.ok).toBe(false);
  });

  it('refuses a read from an extension older than the content floor', async () => {
    const { hub } = connectWithTab(BRIDGE_CONTENT_MIN_VERSION - 1);
    const outcome = await hub.sendCommand({ action: 'extract', tabId: 5, maxChars: 100 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('reading tab content');
  });

  it('routes a read command and returns the page content in data', async () => {
    const { hub, sent } = connectWithTab();
    const p = hub.sendCommand({ action: 'extract', tabId: 5, maxChars: 50 });
    const frame = sent.find((f) => f.type === 'command');
    expect(frame.action).toBe('extract');
    expect(frame.maxChars).toBe(50);
    const data = { url: 'https://a.com', title: 'A', text: 'hello', truncated: false };
    hub.resolveCommand({ type: 'command-result', requestId: frame.requestId, ok: true, data });
    expect(await p).toEqual({ ok: true, data });
  });
});

describe('enforceContentReadGuard', () => {
  it("allows reading YAAR's own tab without a prompt", async () => {
    const selfTab = { url: `http://localhost:${getPort()}/`, isSelf: true };
    expect((await enforceContentReadGuard({ tab: selfTab, sessionId: undefined })).ok).toBe(true);
  });

  it('refuses reading a third-party tab when there is no session to consent', async () => {
    const tab = { url: 'https://a.com/page' };
    const r = await enforceContentReadGuard({ tab, sessionId: undefined });
    expect(r.ok).toBe(false);
  });
});

describe('enforceTabControlGuard', () => {
  it('treats focus/track as non-mutating (no consent, no self-refusal)', async () => {
    expect(isMutatingTabAction('focus')).toBe(false);
    expect(isMutatingTabAction('track')).toBe(false);
    expect(isMutatingTabAction('close')).toBe(true);
    const selfTab = { url: `http://localhost:${getPort()}/`, isSelf: true };
    expect(
      (await enforceTabControlGuard({ tab: selfTab, action: 'focus', sessionId: undefined })).ok,
    ).toBe(true);
  });

  it("refuses to close/move/group YAAR's own tab", async () => {
    const selfTab = { url: `http://localhost:${getPort()}/`, isSelf: true };
    for (const action of ['close', 'group', 'move']) {
      const r = await enforceTabControlGuard({ tab: selfTab, action, sessionId: undefined });
      expect(r.ok).toBe(false);
    }
  });
});

describe('runBridgeAction — manage (focus/close/track/extract)', () => {
  beforeEach(() => getBridgeHub().clearConnection());

  it("'track' pushes an observe cue without a command", async () => {
    const { sent } = connectWithTab();
    const res = await runBridgeAction('track', { tabId: 5 }, undefined);
    expect(res.ok).toBe(true);
    const cue = sent.find((f) => f.type === 'activity');
    expect(cue.kind).toBe('observe');
    expect(sent.find((f) => f.type === 'command')).toBeUndefined();
  });

  it('focus flows guard → activity cue → command → result', async () => {
    const { hub, sent } = connectWithTab();
    const exec = runBridgeAction('focus', { tabId: 5 }, undefined);
    const frame = await waitFor(() => sent.find((f) => f.type === 'command'));
    expect(frame.action).toBe('focus');
    expect(sent.find((f) => f.type === 'activity' && f.kind === 'act')).toBeTruthy();
    hub.resolveCommand({ type: 'command-result', requestId: frame.requestId, ok: true });
    const res = await exec;
    expect(res.ok).toBe(true);
  });

  it('errors on a closed/unknown tab id', async () => {
    connectWithTab();
    const res = await runBridgeAction('focus', { tabId: 999 }, undefined);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });

  it('errors on a missing tabId', async () => {
    connectWithTab();
    const res = await runBridgeAction('focus', {}, undefined);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
  });

  it("extract on YAAR's own tab flows guard → observe cue → command → page text", async () => {
    const hub = getBridgeHub();
    const { socket, sent } = fakeSocket();
    hub.setConnection({ browser: { name: 'Chrome', version: '3' }, protocolVersion: 3 }, socket);
    // A self tab (YAAR's origin) reads without a consent prompt.
    hub.updateTabs([{ id: 7, url: `http://localhost:${getPort()}/`, title: 'YAAR', active: true }]);
    const exec = runBridgeAction('extract', { tabId: 7 }, undefined);
    const frame = await waitFor(() => sent.find((f) => f.type === 'command'));
    expect(frame.action).toBe('extract');
    expect(sent.find((f) => f.type === 'activity' && f.kind === 'observe')).toBeTruthy();
    hub.resolveCommand({
      type: 'command-result',
      requestId: frame.requestId,
      ok: true,
      data: {
        url: `http://localhost:${getPort()}/`,
        title: 'YAAR',
        text: 'page body',
        truncated: false,
      },
    });
    const res = await exec;
    expect(res.ok).toBe(true);
    expect((res.data as { text: string }).text).toBe('page body');
  });

  it('refuses reading a third-party tab with no session to consent', async () => {
    connectWithTab(); // tab 5 → https://a.com, not self
    const res = await runBridgeAction('extract', { tabId: 5 }, undefined);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
  });
});
