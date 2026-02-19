import { describe, it, expect } from 'vitest';
import { InteractionTimeline } from '../agents/interaction-timeline.js';
import type { UserInteraction } from '@yaar/shared';

function makeInteraction(overrides: Partial<UserInteraction> = {}): UserInteraction {
  return {
    type: 'window.close',
    timestamp: Date.now(),
    windowId: 'win1',
    ...overrides,
  };
}

describe('InteractionTimeline', () => {
  it('starts empty', () => {
    const t = new InteractionTimeline();
    expect(t.size).toBe(0);
    expect(t.drain()).toEqual([]);
    expect(t.format()).toBe('');
  });

  it('pushUser increments size', () => {
    const t = new InteractionTimeline();
    t.pushUser(makeInteraction());
    expect(t.size).toBe(1);
  });

  it('pushAI increments size', () => {
    const t = new InteractionTimeline();
    t.pushAI('window-win1', 'task', []);
    expect(t.size).toBe(1);
  });

  it('drain returns all entries and clears', () => {
    const t = new InteractionTimeline();
    t.pushUser(makeInteraction());
    t.pushAI('window-win1', 'task', []);
    expect(t.size).toBe(2);
    const drained = t.drain();
    expect(drained).toHaveLength(2);
    expect(t.size).toBe(0);
  });

  it('clear empties without returning', () => {
    const t = new InteractionTimeline();
    t.pushUser(makeInteraction());
    t.clear();
    expect(t.size).toBe(0);
  });

  it('format produces timeline XML with user interactions', () => {
    const t = new InteractionTimeline();
    t.pushUser(makeInteraction({ type: 'window.close', windowId: 'win-settings' }));
    const output = t.format();
    expect(output).toContain('<timeline>');
    expect(output).toContain('</timeline>');
    expect(output).toContain('<ui:close>win-settings</ui:close>');
  });

  it('format produces timeline XML with AI interactions', () => {
    const t = new InteractionTimeline();
    t.pushAI('window-win1', 'task', [
      {
        type: 'window.create',
        windowId: 'cal-win',
        title: 'Calendar',
        bounds: { x: 0, y: 0, w: 600, h: 400 },
        content: { renderer: 'component', data: '' },
      },
    ]);
    const output = t.format();
    expect(output).toContain('<ai agent="window-win1">');
    expect(output).toContain('Created window "cal-win"');
  });

  it('format handles mixed user and AI entries', () => {
    const t = new InteractionTimeline();
    t.pushUser(makeInteraction({ type: 'window.close', windowId: 'win-settings' }));
    t.pushAI('window-win1', 'task', []);
    t.pushUser(makeInteraction({ type: 'window.focus', windowId: 'win-main' }));
    const output = t.format();
    expect(output).toContain('<ui:close>win-settings</ui:close>');
    expect(output).toContain('<ai agent="window-win1">');
    expect(output).toContain('<ui:focus>win-main</ui:focus>');
  });

  it('format shows "No actions taken." for empty AI actions', () => {
    const t = new InteractionTimeline();
    t.pushAI('ephemeral-1', 'task', []);
    expect(t.format()).toContain('No actions taken.');
  });

  it('drain does not affect subsequent pushes', () => {
    const t = new InteractionTimeline();
    t.pushUser(makeInteraction());
    t.drain();
    t.pushAI('window-win1', 'task', []);
    const drained = t.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0].type).toBe('AI');
  });
});
