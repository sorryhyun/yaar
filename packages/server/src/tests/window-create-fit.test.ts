/**
 * A new window opens on screen, and the agent is told when it was moved there.
 *
 * The monitor asked for a 1400px window at x=306 on a 1600px desktop. The server passed the
 * bounds through as given, the desktop narrowed the window in place, and its window controls
 * and the app's right-hand buttons ended up off screen (GitHub issue #182). `handleCreate`
 * now fits the bounds to the monitor's last reported viewport, moving before shrinking,
 * and says so in the result when the caller's own numbers changed.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { WINDOW_PLACEMENT, type OSAction, type WindowBounds } from '@yaar/shared';
import { runWithAgentContext } from '../agents/agent-context.js';
import { actionEmitter, type ActionEvent } from '../session/action-emitter.js';
import { handleCreate } from '../features/window/create.js';
import { getSessionHub } from '../session/session-hub.js';
import type { SessionId } from '../session/types.js';

const SESSION = 'window-create-fit' as SessionId;

async function openSession(viewport?: { w: number; h: number }, mobile = false) {
  const { session } = getSessionHub().attach(SESSION, {});
  if (viewport) session.layoutContext.setViewport('0', viewport);
  if (mobile) session.layoutContext.setFormFactor('0', 'mobile');
}

async function create(payload: Record<string, unknown>) {
  const seen: ActionEvent[] = [];
  const listen = (e: ActionEvent) => seen.push(e);
  actionEmitter.on('action', listen);
  try {
    const result = await runWithAgentContext(
      { agentId: 'agent-m0', sessionId: SESSION, monitorId: '0', role: 'monitor' },
      () => handleCreate('', { renderer: 'markdown', content: '# hi', ...payload }),
    );
    const action = seen.find((e) => e.action.type === 'window.create')?.action as
      | (OSAction & { bounds: WindowBounds })
      | undefined;
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    return { result, bounds: action?.bounds, text };
  } finally {
    actionEmitter.off('action', listen);
  }
}

afterEach(async () => {
  await getSessionHub().remove(SESSION);
});

describe('handleCreate fits a new window to the desktop', () => {
  it('moves the reported window left instead of cutting off its right edge (#182)', async () => {
    await openSession({ w: 1600, h: 900 });
    const { bounds, text } = await create({
      title: 'board',
      x: 306,
      y: 40,
      width: 1400,
      height: 600,
    });
    expect(bounds).toEqual({ x: 200, y: 40, w: 1400, h: 600 });
    expect(text).toContain('boundsAdjusted');
    expect(text).toContain('1400×600 at x=306, y=40');
    expect(text).toContain('1600×900 desktop');
  });

  it('shrinks only a window larger than the desktop, keeping the palette strip clear', async () => {
    await openSession({ w: 1600, h: 900 });
    const { bounds } = await create({ title: 'huge', x: 10, y: 10, width: 2400, height: 2000 });
    expect(bounds).toEqual({ x: 0, y: 0, w: 1600, h: 900 - WINDOW_PLACEMENT.paletteInset });
  });

  it('says nothing when the requested bounds already fit', async () => {
    await openSession({ w: 1600, h: 900 });
    const { bounds, text } = await create({
      title: 'fits',
      x: 100,
      y: 80,
      width: 800,
      height: 500,
    });
    expect(bounds).toEqual({ x: 100, y: 80, w: 800, h: 500 });
    expect(text).not.toContain('boundsAdjusted');
  });

  it('fits a default-placed window without reporting an adjustment nobody asked for', async () => {
    await openSession({ w: 1600, h: 900 });
    const { bounds, text } = await create({ title: 'auto' });
    expect(bounds).toBeDefined();
    expect(bounds!.x + bounds!.w).toBeLessThanOrEqual(1600);
    expect(text).not.toContain('boundsAdjusted');
  });

  it('passes bounds through when no viewport has been reported', async () => {
    await openSession();
    const { bounds, text } = await create({
      title: 'blind',
      x: 306,
      y: 40,
      width: 1400,
      height: 600,
    });
    expect(bounds).toEqual({ x: 306, y: 40, w: 1400, h: 600 });
    expect(text).not.toContain('boundsAdjusted');
  });

  it('leaves a phone alone — its windows are full-screen cards', async () => {
    await openSession({ w: 412, h: 915 }, true);
    const { bounds, text } = await create({
      title: 'phone',
      x: 306,
      y: 40,
      width: 1400,
      height: 600,
    });
    expect(bounds).toEqual({ x: 306, y: 40, w: 1400, h: 600 });
    expect(text).not.toContain('boundsAdjusted');
  });
});
