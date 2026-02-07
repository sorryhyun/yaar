/**
 * Tests for CallbackQueue — push, drain, format, clear, size.
 */
import { describe, it, expect } from 'vitest';
import { CallbackQueue, type AgentCallback } from '../agents/callback-queue.js';

function makeCb(overrides: Partial<AgentCallback> = {}): AgentCallback {
  return {
    role: 'ephemeral-1',
    task: 'app: Calendar',
    actions: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('CallbackQueue', () => {
  it('starts empty', () => {
    const q = new CallbackQueue();
    expect(q.size).toBe(0);
    expect(q.drain()).toEqual([]);
    expect(q.format()).toBe('');
  });

  it('push increments size', () => {
    const q = new CallbackQueue();
    q.push(makeCb());
    expect(q.size).toBe(1);
    q.push(makeCb({ role: 'ephemeral-2' }));
    expect(q.size).toBe(2);
  });

  it('drain returns all items and clears queue', () => {
    const q = new CallbackQueue();
    const cb1 = makeCb({ role: 'ephemeral-1' });
    const cb2 = makeCb({ role: 'window-settings' });
    q.push(cb1);
    q.push(cb2);
    expect(q.size).toBe(2);

    const drained = q.drain();
    expect(drained).toEqual([cb1, cb2]);
    expect(q.size).toBe(0);
    expect(q.drain()).toEqual([]);
  });

  it('clear empties without returning', () => {
    const q = new CallbackQueue();
    q.push(makeCb());
    q.push(makeCb());
    q.clear();
    expect(q.size).toBe(0);
    expect(q.drain()).toEqual([]);
  });

  it('format returns empty string when no callbacks', () => {
    const q = new CallbackQueue();
    expect(q.format()).toBe('');
  });

  it('format produces XML with agent attributes', () => {
    const q = new CallbackQueue();
    q.push(makeCb({
      role: 'ephemeral-1',
      task: 'app: Calendar',
      actions: [
        { type: 'window.create', windowId: 'cal-win', title: 'Calendar', bounds: { x: 0, y: 0, w: 600, h: 400 }, content: { renderer: 'component', data: '' } },
      ],
    }));

    const output = q.format();
    expect(output).toContain('<agent_callbacks>');
    expect(output).toContain('</agent_callbacks>');
    expect(output).toContain('agent="ephemeral-1"');
    expect(output).toContain('task="app: Calendar"');
    expect(output).toContain('Created window "cal-win"');
  });

  it('format includes windowId attribute for window agents', () => {
    const q = new CallbackQueue();
    q.push(makeCb({
      role: 'window-settings',
      task: 'button "Save"',
      windowId: 'settings-win',
      actions: [
        { type: 'notification.show', id: 'n1', title: 'Settings saved', body: 'Settings saved' },
      ],
    }));

    const output = q.format();
    expect(output).toContain('window="settings-win"');
    expect(output).toContain('Showed notification: "Settings saved"');
  });

  it('format handles multiple callbacks', () => {
    const q = new CallbackQueue();
    q.push(makeCb({ role: 'ephemeral-1', task: 'task-a', actions: [] }));
    q.push(makeCb({ role: 'ephemeral-2', task: 'task-b', actions: [] }));
    q.push(makeCb({ role: 'window-win1', task: 'task-c', windowId: 'win1', actions: [] }));

    const output = q.format();
    expect(output).toContain('agent="ephemeral-1"');
    expect(output).toContain('agent="ephemeral-2"');
    expect(output).toContain('agent="window-win1"');
    // 3 callback blocks
    expect(output.match(/<callback /g)?.length).toBe(3);
  });

  it('format shows "No actions taken." for empty actions', () => {
    const q = new CallbackQueue();
    q.push(makeCb({ actions: [] }));
    expect(q.format()).toContain('No actions taken.');
  });

  it('format summarizes various action types', () => {
    const q = new CallbackQueue();
    q.push(makeCb({
      actions: [
        { type: 'window.close', windowId: 'old-win' },
        { type: 'window.setTitle', windowId: 'my-win', title: 'New Title' },
        { type: 'window.setContent', windowId: 'my-win', content: { renderer: 'markdown', data: 'hello' } },
        { type: 'notification.dismiss', id: 'n1' },
      ],
    }));

    const output = q.format();
    expect(output).toContain('Closed window "old-win"');
    expect(output).toContain('Set title of "my-win" to "New Title"');
    expect(output).toContain('Updated content of "my-win"');
    expect(output).toContain('Dismissed notification "n1"');
  });

  it('drain does not affect subsequent pushes', () => {
    const q = new CallbackQueue();
    q.push(makeCb({ role: 'a' }));
    q.drain();
    q.push(makeCb({ role: 'b' }));
    const drained = q.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0].role).toBe('b');
  });
});
