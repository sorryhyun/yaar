import { describe, it, expect } from 'vitest';
import { WindowStateRegistry } from '../mcp/window-state.js';
import { ReloadCache } from '../reload/cache.js';
import type { Fingerprint } from '../reload/types.js';
import type { OSAction } from '@yaar/shared';

describe('session-scoped state', () => {
  it('isolates window state across two sessions', () => {
    const stateA = new WindowStateRegistry();
    const stateB = new WindowStateRegistry();

    stateA.handleAction({
      type: 'window.create',
      windowId: 'a-win',
      title: 'A Window',
      bounds: { x: 0, y: 0, w: 400, h: 300 },
      content: { renderer: 'markdown', data: 'A' },
    });

    stateB.handleAction({
      type: 'window.create',
      windowId: 'b-win',
      title: 'B Window',
      bounds: { x: 10, y: 10, w: 400, h: 300 },
      content: { renderer: 'markdown', data: 'B' },
    });

    expect(stateA.hasWindow('a-win')).toBe(true);
    expect(stateA.hasWindow('b-win')).toBe(false);
    expect(stateB.hasWindow('b-win')).toBe(true);
    expect(stateB.hasWindow('a-win')).toBe(false);
  });

  it('isolates reload cache entries across two sessions', () => {
    const cacheA = new ReloadCache('/tmp/test-cache-a.json');
    const cacheB = new ReloadCache('/tmp/test-cache-b.json');

    const fingerprint: Fingerprint = {
      triggerType: 'main',
      ngrams: ['open', 'app'],
      contentHash: 'same-content',
      windowStateHash: 'same-windows',
    };

    const actions: OSAction[] = [
      {
        type: 'window.create',
        windowId: 'shared-window-id',
        title: 'Shared',
        bounds: { x: 0, y: 0, w: 200, h: 200 },
        content: { renderer: 'markdown', data: 'hello' },
      },
    ];

    cacheA.record(fingerprint, actions, 'entry A');
    cacheB.record(fingerprint, actions, 'entry B');

    expect(cacheA.listEntries()).toHaveLength(1);
    expect(cacheB.listEntries()).toHaveLength(1);
    expect(cacheA.listEntries()[0]?.label).toBe('entry A');
    expect(cacheB.listEntries()[0]?.label).toBe('entry B');
  });

  it('clearing one registry does not affect the other', () => {
    const stateA = new WindowStateRegistry();
    const stateB = new WindowStateRegistry();

    stateA.handleAction({
      type: 'window.create',
      windowId: 'a-win',
      title: 'A Window',
      bounds: { x: 0, y: 0, w: 400, h: 300 },
      content: { renderer: 'markdown', data: 'A' },
    });
    stateB.handleAction({
      type: 'window.create',
      windowId: 'b-win',
      title: 'B Window',
      bounds: { x: 10, y: 10, w: 400, h: 300 },
      content: { renderer: 'markdown', data: 'B' },
    });

    stateA.clear();

    expect(stateA.listWindows()).toHaveLength(0);
    expect(stateB.listWindows()).toHaveLength(1);
  });
});
