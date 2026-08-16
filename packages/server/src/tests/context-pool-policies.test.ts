import { describe, it, expect } from 'bun:test';
import { MonitorQueuePolicy } from '../agents/context-pool-policies/monitor-queue-policy.js';
import { WindowQueuePolicy } from '../agents/context-pool-policies/window-queue-policy.js';
import { ContextAssemblyPolicy } from '../agents/context-pool-policies/context-assembly-policy.js';
import { ReloadCachePolicy } from '../agents/context-pool-policies/reload-cache-policy.js';
import {
  WindowSubscriptionPolicy,
  frameAppEvent,
  MAX_PAYLOAD_CHARS,
} from '../agents/context-pool-policies/window-subscription-policy.js';
import type { Task } from '../agents/pool-types.js';

describe('MonitorQueuePolicy', () => {
  it('preserves FIFO ordering', () => {
    const policy = new MonitorQueuePolicy(3);
    const t1: Task = { requestedType: 'monitor', kind: 'user', messageId: '1', content: 'a' };
    const t2: Task = { requestedType: 'monitor', kind: 'user', messageId: '2', content: 'b' };

    policy.enqueue(t1);
    policy.enqueue(t2);

    expect(policy.dequeue()?.task.messageId).toBe('1');
    expect(policy.dequeue()?.task.messageId).toBe('2');
  });

  it('enforces queue size limit checks', () => {
    const policy = new MonitorQueuePolicy(1);
    policy.enqueue({ requestedType: 'monitor', kind: 'user', messageId: '1', content: 'a' });
    expect(policy.canEnqueue()).toBe(false);
  });
});

describe('WindowQueuePolicy', () => {
  it('queues sequentially per key', () => {
    const policy = new WindowQueuePolicy();
    policy.enqueue('w1', {
      requestedType: 'app',
      kind: 'user',
      windowId: 'w1',
      messageId: '1',
      content: 'first',
    });
    policy.enqueue('w1', {
      requestedType: 'app',
      kind: 'user',
      windowId: 'w1',
      messageId: '2',
      content: 'second',
    });

    expect(policy.dequeue('w1')?.task.messageId).toBe('1');
    expect(policy.dequeue('w1')?.task.messageId).toBe('2');
  });

  // The window queue was unbounded, so a wedged app agent accumulated every later click
  // with no ceiling and no refusal. The bound is per key: one stuck app must not start
  // refusing another app's messages.
  it('bounds each key independently', () => {
    const policy = new WindowQueuePolicy(1);
    expect(policy.canEnqueue('app-0-memo')).toBe(true);
    policy.enqueue('app-0-memo', {
      requestedType: 'app',
      kind: 'user',
      windowId: 'w1',
      messageId: '1',
      content: 'a',
    });

    expect(policy.canEnqueue('app-0-memo')).toBe(false);
    expect(policy.canEnqueue('app-0-notes')).toBe(true);
    expect(policy.maxSize).toBe(1);

    // Draining makes room again.
    policy.dequeue('app-0-memo');
    expect(policy.canEnqueue('app-0-memo')).toBe(true);
  });
});

describe('ContextAssemblyPolicy', () => {
  it('formats open windows context with details', () => {
    const policy = new ContextAssemblyPolicy();
    const windows = policy.formatOpenWindows([
      {
        id: 'w-1',
        title: 'Notes',
        content: { renderer: 'markdown', data: '' },
        bounds: { x: 0, y: 0, w: 400, h: 300 },
        locked: false,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'w-2',
        title: 'Chat',
        content: { renderer: 'iframe', data: '' },
        bounds: { x: 500, y: 0, w: 400, h: 300 },
        locked: false,
        createdAt: 0,
        updatedAt: 0,
      },
    ]);
    expect(windows).toContain('yaar://windows/w-1 — Notes');
    expect(windows).toContain('yaar://windows/w-2 — Chat');
    expect(windows).toContain('<open_windows>');
    // Exact geometry replaces fuzzy position labels.
    expect(windows).toContain('400×300 at (0,0)');
    expect(windows).toContain('400×300 at (500,0)');
    // Non-overlapping windows produce no overlap note.
    expect(windows).not.toContain('overlaps');
  });

  it('reports stack position, which window covers which, minimized, and locked facts', () => {
    const policy = new ContextAssemblyPolicy();
    // Array order is the stack, bottom first — `a` is under `b`.
    const windows = policy.formatOpenWindows(
      [
        {
          id: 'a',
          title: 'A',
          content: { renderer: 'markdown', data: '' },
          bounds: { x: 0, y: 0, w: 400, h: 300 },
          locked: false,
          createdAt: 0,
          updatedAt: 0,
        },
        {
          id: 'b',
          title: 'B',
          content: { renderer: 'markdown', data: '' },
          bounds: { x: 100, y: 100, w: 400, h: 300 },
          locked: true,
          createdAt: 0,
          updatedAt: 0,
        },
        {
          id: 'c',
          title: 'C',
          content: { renderer: 'markdown', data: '' },
          bounds: { x: 0, y: 0, w: 400, h: 300 },
          locked: false,
          minimized: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      { focusedWindowId: 'b' },
    );
    // The one under reports what hides it; the one on top reports what it hides.
    expect(windows).toContain('yaar://windows/a — A · 400×300 at (0,0) · z:0 · covered by b');
    expect(windows).toContain('yaar://windows/b — B · 400×300 at (100,100) · z:1 · covers a');
    expect(windows).toContain('focused');
    expect(windows).toContain('locked');
    // Minimized windows report no geometry, no stack position, and no overlap.
    expect(windows).toContain('yaar://windows/c — C · minimized');
  });

  it('includes monitor and current window in open_windows header', () => {
    const policy = new ContextAssemblyPolicy();
    const windows = policy.formatOpenWindows(
      [
        {
          id: 'chat',
          title: 'Chat',
          content: { renderer: 'iframe', data: '' },
          bounds: { x: 0, y: 0, w: 400, h: 300 },
          locked: false,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      { monitorId: '0', currentWindowId: 'chat' },
    );
    expect(windows).toContain('monitor="0"');
    expect(windows).toContain('yaar://windows/chat — Chat (you)');
  });
});

describe('ReloadCachePolicy', () => {
  it('generates friendly labels', () => {
    // Pass a minimal mock cache — only generateCacheLabel is tested here
    const policy = new ReloadCachePolicy({ findMatches: () => [], record: () => {} } as any);
    expect(
      policy.generateCacheLabel({
        requestedType: 'monitor',
        kind: 'user',
        messageId: '1',
        content: 'app: moltbook',
      }),
    ).toBe('Open moltbook app');
    expect(
      policy.generateCacheLabel({
        requestedType: 'app',
        kind: 'user',
        windowId: 'w',
        messageId: '2',
        content: 'click button "Save" now',
      }),
    ).toBe('Click "Save"');
  });
});

describe('WindowSubscriptionPolicy — app event channels', () => {
  function subOpts(
    over: Partial<Parameters<WindowSubscriptionPolicy['subscribeChannels']>[0]> = {},
  ) {
    return {
      subscriberAgentKey: 'monitor-0',
      subscriberType: 'monitor' as const,
      subscriberMonitorId: '0',
      targetWindowId: 'browser-user',
      channels: ['dialog'],
      debounceMs: 10,
      ...over,
    };
  }

  it('wakes a wake-mode subscriber with framed <app:event> content', async () => {
    const policy = new WindowSubscriptionPolicy();
    policy.subscribeChannels(subOpts({ mode: 'wake' }));

    const delivered: Task[] = [];
    const matched = policy.notifyChannel(
      'browser-user',
      'dialog',
      { kind: 'alert', message: 'hi' },
      undefined,
      (t) => delivered.push(t),
      () => {},
    );

    expect(matched).toBe(1);
    // Debounced — nothing delivered synchronously.
    expect(delivered.length).toBe(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(delivered.length).toBe(1);
    expect(delivered[0].content).toContain('<app:event window="browser-user" channel="dialog">');
    expect(delivered[0].content).toContain('"message":"hi"');
    expect(delivered[0].monitorId).toBe('0');
  });

  it('buffers a buffer-mode subscriber immediately without a task', () => {
    const policy = new WindowSubscriptionPolicy();
    policy.subscribeChannels(subOpts({ mode: 'buffer' }));

    const delivered: Task[] = [];
    const buffered: string[] = [];
    policy.notifyChannel(
      'browser-user',
      'dialog',
      { kind: 'confirm' },
      undefined,
      (t) => delivered.push(t),
      (_sub, content) => buffered.push(content),
    );

    expect(delivered.length).toBe(0);
    expect(buffered.length).toBe(1);
    expect(buffered[0]).toContain('channel="dialog"');
  });

  it('matches "*" wildcard channels and filters others', async () => {
    const policy = new WindowSubscriptionPolicy();
    policy.subscribeChannels(subOpts({ channels: ['*'], mode: 'wake' }));

    const delivered: Task[] = [];
    const deliver = (t: Task) => delivered.push(t);
    expect(
      policy.notifyChannel('browser-user', 'navigated', {}, undefined, deliver, () => {}),
    ).toBe(1);
    // Different window — no match.
    expect(
      policy.notifyChannel('other-window', 'navigated', {}, undefined, deliver, () => {}),
    ).toBe(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(delivered.length).toBe(1);
  });

  it('skips self-notification from the same agent', () => {
    const policy = new WindowSubscriptionPolicy();
    policy.subscribeChannels(subOpts({ mode: 'wake' }));

    const matched = policy.notifyChannel(
      'browser-user',
      'dialog',
      {},
      'monitor-0', // same as subscriberAgentKey
      () => {},
      () => {},
    );
    expect(matched).toBe(0);
  });

  it('stops delivering after unsubscribe and window teardown', async () => {
    const policy = new WindowSubscriptionPolicy();
    const id = policy.subscribeChannels(subOpts({ mode: 'wake' }));

    const delivered: Task[] = [];
    policy.notifyChannel(
      'browser-user',
      'dialog',
      {},
      undefined,
      (t) => delivered.push(t),
      () => {},
    );
    // Unsubscribe cancels the pending debounced delivery.
    expect(policy.unsubscribe(id)).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(delivered.length).toBe(0);

    // A fresh sub cleared by clearForWindow also stops matching.
    policy.subscribeChannels(subOpts({ mode: 'wake' }));
    policy.clearForWindow('browser-user');
    expect(
      policy.notifyChannel(
        'browser-user',
        'dialog',
        {},
        undefined,
        () => {},
        () => {},
      ),
    ).toBe(0);
  });

  it('does not cross-fire between window-change and channel subscriptions', () => {
    const policy = new WindowSubscriptionPolicy();
    // A window-change subscription on the same window must not receive channel events.
    policy.subscribe({
      subscriberAgentKey: 'monitor-0',
      subscriberType: 'monitor',
      subscriberMonitorId: '0',
      targetWindowId: 'browser-user',
      events: ['content'],
    });
    expect(
      policy.notifyChannel(
        'browser-user',
        'dialog',
        {},
        undefined,
        () => {},
        () => {},
      ),
    ).toBe(0);
  });

  it('truncates oversized payloads in the framed event', () => {
    const size = MAX_PAYLOAD_CHARS + 1000;
    const big = 'x'.repeat(size);
    // Plain strings pass through without JSON quoting → body length === size.
    const framed = frameAppEvent('w', 'dialog', big);
    expect(framed).toContain(`[truncated, ${size} chars]`);
    // Body capped at MAX_PAYLOAD_CHARS + truncation note; frame stays under the raw size.
    expect(framed.length).toBeLessThan(MAX_PAYLOAD_CHARS + 200);
  });
});
