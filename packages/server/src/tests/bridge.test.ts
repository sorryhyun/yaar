/**
 * Tests for the YAAR Bridge T1 (Observe) + T2 (Manage) surfaces:
 *  - BridgeHub state transitions + isSelf annotation
 *  - shared message schema round-trip + version constants
 *  - the yaar://browser/* verb handlers resolve, read, and invoke
 *  - T2 command transport (requestId correlation, old-extension + disconnect refusal)
 *  - the tab-control guard (self-target refusal, focus/track are free)
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  bridgeMessageSchema,
  bridgeServerMessageSchema,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_COMMAND_MIN_VERSION,
} from '@yaar/shared';
import { getBridgeHub, type BridgeSocket } from '../features/browser/bridge.js';
import { enforceTabControlGuard, isMutatingTabAction } from '../features/browser/guards.js';
import { ResourceRegistry } from '../handlers/uri-registry.js';
import { registerBrowserHandlers } from '../handlers/browser.js';
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

const text = (r: {
  content: Array<{ type: string; text?: string; resource?: { text?: string } }>;
}) => r.content[0] as { type: string; text?: string; resource?: { text?: string } };

/** Pull the JSON body out of an okJsonResource result. */
function jsonBody(r: { content: Array<{ type: string; resource?: { text?: string } }> }): any {
  const block = r.content.find((c) => c.type === 'resource');
  return block?.resource?.text ? JSON.parse(block.resource.text) : null;
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

describe('yaar://browser/* handlers', () => {
  let registry: ResourceRegistry;

  beforeEach(() => {
    getBridgeHub().clearConnection();
    registry = new ResourceRegistry();
    registerBrowserHandlers(registry);
  });

  it('reads the tab list once connected (guards the resolveUri fix)', async () => {
    const hub = getBridgeHub();
    hub.setConnection(
      { browser: { name: 'Chrome', version: '1' }, protocolVersion: 1 },
      { send() {} },
    );
    hub.updateTabs([{ id: 7, url: 'https://a.com', title: 'A', active: true }]);

    const res = await registry.execute('read', 'yaar://browser/tabs');
    expect(res.isError).toBeUndefined();
    const body = jsonBody(res);
    expect(body.fidelity).toBe('bridge');
    expect(body.tabs).toHaveLength(1);
    expect(body.tabs[0].id).toBe(7);
  });

  it('reads a single tab by id', async () => {
    getBridgeHub().updateTabs([{ id: 42, url: 'https://a.com', title: 'A', active: true }]);
    const res = await registry.execute('read', 'yaar://browser/tabs/42');
    expect(res.isError).toBeUndefined();
    expect(jsonBody(res).id).toBe(42);
  });

  it('errors on a missing tab id', async () => {
    const res = await registry.execute('read', 'yaar://browser/tabs/999');
    expect(res.isError).toBe(true);
  });

  it('gives a friendly message when disconnected', async () => {
    const res = await registry.execute('read', 'yaar://browser/tabs');
    expect(res.isError).toBeUndefined();
    expect(text(res).text).toContain('not connected');
  });

  it('reads the presence summary', async () => {
    const hub = getBridgeHub();
    hub.setConnection(
      { browser: { name: 'Chrome', version: '1' }, protocolVersion: 1 },
      { send() {} },
    );
    hub.updateTabs([{ id: 1, url: 'https://a.com', title: 'A', active: true }]);
    const res = await registry.execute('read', 'yaar://browser/presence');
    const body = jsonBody(res);
    expect(body.fidelity).toBe('bridge');
    expect(body.tabCount).toBe(1);
    expect(body.activeTab.id).toBe(1);
  });

  it('lists tabs as navigable links', async () => {
    getBridgeHub().updateTabs([
      { id: 1, url: 'https://a.com', title: 'A', active: true },
      { id: 2, url: 'https://b.com', title: 'B', active: false },
    ]);
    const res = await registry.execute('list', 'yaar://browser/tabs');
    const links = res.content.filter((c) => c.type === 'resource_link');
    expect(links).toHaveLength(2);
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

describe('yaar://browser/tabs invoke (T2)', () => {
  let registry: ResourceRegistry;
  beforeEach(() => {
    getBridgeHub().clearConnection();
    registry = new ResourceRegistry();
    registerBrowserHandlers(registry);
  });

  it('exposes invoke in the tab handler verbs', async () => {
    const res = await registry.execute('describe', 'yaar://browser/tabs');
    expect(text(res).text).toContain('invoke');
  });

  it("'track' pushes an observe activity cue without a command", async () => {
    const { sent } = connectWithTab();
    const res = await registry.execute('invoke', 'yaar://browser/tabs/5', { action: 'track' });
    expect(res.isError).toBeUndefined();
    const cue = sent.find((f) => f.type === 'activity');
    expect(cue.kind).toBe('observe');
    expect(sent.find((f) => f.type === 'command')).toBeUndefined();
  });

  it('focus flows guard → activity cue → command → result', async () => {
    const { hub, sent } = connectWithTab();
    const exec = registry.execute('invoke', 'yaar://browser/tabs/5', { action: 'focus' });
    // The handler defers guard/agent-context via dynamic import, so let a few ticks flush
    // before the command frame lands.
    const frame = await waitFor(() => sent.find((f) => f.type === 'command'));
    expect(frame.action).toBe('focus');
    expect(sent.find((f) => f.type === 'activity' && f.kind === 'act')).toBeTruthy();
    hub.resolveCommand({ type: 'command-result', requestId: frame.requestId, ok: true });
    const res = await exec;
    expect(res.isError).toBeUndefined();
  });

  it('errors invoking a closed/unknown tab id', async () => {
    connectWithTab();
    const res = await registry.execute('invoke', 'yaar://browser/tabs/999', { action: 'focus' });
    expect(res.isError).toBe(true);
  });

  it('errors on an unknown action', async () => {
    connectWithTab();
    const res = await registry.execute('invoke', 'yaar://browser/tabs/5', { action: 'explode' });
    expect(res.isError).toBe(true);
  });
});
