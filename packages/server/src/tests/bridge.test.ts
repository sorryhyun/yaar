/**
 * Tests for the YAAR Bridge T1 (Observe) surface:
 *  - BridgeHub state transitions + isSelf annotation
 *  - shared message schema round-trip + version constant
 *  - the yaar://browser/* verb handlers resolve and read (guards the resolveUri fix)
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { bridgeMessageSchema, BRIDGE_PROTOCOL_VERSION } from '@yaar/shared';
import { getBridgeHub } from '../features/browser/bridge.js';
import { ResourceRegistry } from '../handlers/uri-registry.js';
import { registerBrowserHandlers } from '../handlers/browser.js';
import { getPort } from '../config.js';

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
    hub.setConnection({ browser: { name: 'Chrome', version: '138' }, protocolVersion: 1 });
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
    hub.setConnection({ browser: { name: 'Chrome', version: '1' }, protocolVersion: 1 });
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
    hub.setConnection({ browser: { name: 'Chrome', version: '1' }, protocolVersion: 1 });
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
    hub.setConnection({ browser: { name: 'Chrome', version: '1' }, protocolVersion: 1 });
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
