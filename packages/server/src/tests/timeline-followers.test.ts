/**
 * A timeline follower — the second reader of one desktop (the hosted Remote Control
 * session) — sees every entry the monitor's own timeline does, and draining either
 * leaves the other untouched.
 */
import { describe, expect, test } from 'bun:test';
import type { UserInteraction } from '@yaar/shared';
import { InteractionTimeline } from '../agents/interaction-timeline.js';

function close(windowId: string): UserInteraction {
  return { type: 'window.close', windowId, timestamp: Date.now() } as UserInteraction;
}

describe('InteractionTimeline followers', () => {
  test('every kind of push is copied into the follower', () => {
    const follower = new InteractionTimeline();
    const timeline = new InteractionTimeline(() => [follower]);

    timeline.pushUser(close('win-a'));
    timeline.pushAI('window-win-b', 'task', [], undefined, 'done');
    timeline.pushRaw('<app:event>x</app:event>');

    const own = timeline.drainAndFormat();
    const copy = follower.drainAndFormat();
    expect(copy).toBe(own);
    expect(copy).toContain('win-a');
    expect(copy).toContain('Response: done');
    expect(copy).toContain('<app:event>x</app:event>');
  });

  test('the two drain independently', () => {
    const follower = new InteractionTimeline();
    const timeline = new InteractionTimeline(() => [follower]);

    timeline.pushUser(close('win-a'));
    expect(timeline.drainAndFormat()).toContain('win-a');
    // The monitor agent's drain took nothing from the follower...
    timeline.pushUser(close('win-b'));
    const copy = follower.drainAndFormat();
    expect(copy).toContain('win-a');
    expect(copy).toContain('win-b');
    // ...and the follower's took nothing from the monitor agent.
    expect(timeline.drainAndFormat()).toContain('win-b');
    expect(follower.size).toBe(0);
  });

  test('a follower attached later hears only what comes after', () => {
    const followers: InteractionTimeline[] = [];
    const timeline = new InteractionTimeline(() => followers);

    timeline.pushUser(close('before'));
    const follower = new InteractionTimeline();
    followers.push(follower);
    timeline.pushUser(close('after'));

    const copy = follower.drainAndFormat();
    expect(copy).not.toContain('before');
    expect(copy).toContain('after');
  });
});
