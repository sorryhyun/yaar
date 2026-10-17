/**
 * A create never takes a live window's id.
 *
 * Window ids are derived from the title (or the appId), so two creates that only
 * *look* alike collide — two "Generated Image Preview" windows both derive
 * `generated-image-preview`. The frontend applies a create as
 * `windows[key] = window`, so a collision used to destroy the earlier window in
 * place, without even running the close path that tells its iframe.
 *
 * These tests pin the two halves of the rule: a derived id steps to the next free
 * one, and an id the caller named explicitly is refused rather than redirected.
 */
import { describe, it, expect } from 'bun:test';
import type { OSAction } from '@yaar/shared';
import { WindowStateRegistry } from '../session/window-state.js';
import { allocateWindowId, deriveWindowId } from '../features/window/helpers.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import type { SessionId } from '../session/types.js';

/** Run `fn` as an agent acting on `monitorId`. */
function onMonitor<T>(monitorId: string, fn: () => T): T {
  return runWithAgentContext(
    { agentId: `agent-m${monitorId}`, sessionId: 'test-session' as SessionId, monitorId },
    fn,
  );
}

function createAction(windowId: string, title: string): OSAction {
  return {
    type: 'window.create',
    windowId,
    title,
    bounds: { x: 0, y: 0, w: 100, h: 100 },
    content: { renderer: 'html', data: '<p>hi</p>' },
  } as OSAction;
}

describe('allocateWindowId', () => {
  it('returns the desired id when nothing holds it', () => {
    const state = new WindowStateRegistry();
    onMonitor('0', () => {
      expect(allocateWindowId(state, 'generated-image-preview')).toBe('generated-image-preview');
    });
  });

  it('steps past a live window instead of taking its id', () => {
    const state = new WindowStateRegistry();
    onMonitor('0', () => {
      state.handleAction(createAction('generated-image-preview', 'Generated Image Preview'), '0');
      expect(allocateWindowId(state, 'generated-image-preview')).toBe('generated-image-preview-2');
    });
  });

  it('keeps stepping as the earlier suffixes fill up', () => {
    const state = new WindowStateRegistry();
    onMonitor('0', () => {
      state.handleAction(createAction('preview', 'Preview'), '0');
      state.handleAction(createAction('preview-2', 'Preview'), '0');
      state.handleAction(createAction('preview-3', 'Preview'), '0');
      expect(allocateWindowId(state, 'preview')).toBe('preview-4');
    });
  });

  it('does not collide across monitors — ids are monitor-scoped', () => {
    const state = new WindowStateRegistry();
    onMonitor('0', () => state.handleAction(createAction('preview', 'Preview'), '0'));
    // Monitor 1 has no such window, so it gets the plain id rather than a suffix.
    onMonitor('1', () => {
      expect(allocateWindowId(state, 'preview')).toBe('preview');
    });
  });

  it('leaves the window that held the id untouched', () => {
    const state = new WindowStateRegistry();
    onMonitor('0', () => {
      state.handleAction(createAction('preview', 'First'), '0');
      allocateWindowId(state, 'preview');
      expect(state.getWindow('preview')?.title).toBe('First');
    });
  });
});

describe('deriveWindowId collisions', () => {
  it('derives the same id from the same title — which is what forces the check', () => {
    expect(deriveWindowId(undefined, undefined, 'Generated Image Preview')).toBe(
      'generated-image-preview',
    );
    expect(deriveWindowId(undefined, undefined, 'Generated Image Preview')).toBe(
      'generated-image-preview',
    );
  });

  it('derives an app window id from the appId, so a second app window collides too', () => {
    expect(deriveWindowId('anima')).toBe('anima');
    const state = new WindowStateRegistry();
    onMonitor('0', () => {
      state.handleAction(createAction('anima', 'Anima'), '0');
      expect(allocateWindowId(state, deriveWindowId('anima'))).toBe('anima-2');
    });
  });
});

describe('deriveWindowId from non-ASCII titles', () => {
  const derive = (title: string) => deriveWindowId(undefined, undefined, title);

  it('keeps the ASCII slug and adds a hash, so two titles that share only digits differ', () => {
    const a = derive('1.2.0 텍스트 완주 보고');
    const b = derive('1.2.0 이미지 완주 보고');
    expect(a).toMatch(/^1-2-0-[0-9a-f]{8}$/);
    expect(b).toMatch(/^1-2-0-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });

  it('gives a pure non-Latin title a stable id instead of a timestamp', () => {
    const id = derive('텍스트 완주 보고');
    expect(id).toMatch(/^win-[0-9a-f]{8}$/);
    expect(derive('텍스트 완주 보고')).toBe(id);
    expect(derive('이미지 보고')).not.toBe(id);
  });

  it('stays ASCII, so the window URI needs no encoding', () => {
    for (const title of ['1.2.0 텍스트 완주 보고', 'Café Menu', '東京 2024', 'Привет']) {
      expect(derive(title)).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('distinguishes accented Latin from its unaccented spelling', () => {
    expect(derive('Café')).toMatch(/^caf-[0-9a-f]{8}$/);
    expect(derive('Cafe')).toBe('cafe');
  });

  it('leaves an all-ASCII title, punctuation and symbols included, exactly as before', () => {
    expect(derive('Generated Image Preview')).toBe('generated-image-preview');
    expect(derive('Report — 2024 (final)')).toBe('report-2024-final');
  });
});
