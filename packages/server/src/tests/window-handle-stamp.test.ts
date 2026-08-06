/**
 * The one ordering rule for stamping a scoped handle onto an outgoing action.
 *
 * Three emit paths used to carry three copies of this rule and only one had it right;
 * these are the two cases that told them apart — a `create`, whose handle does not exist
 * until the action has been applied, and a `close`, whose handle does not exist any more.
 */

import { describe, expect, it } from 'bun:test';
import type { OSAction } from '@yaar/shared';
import { WindowHandleMap } from '../session/window-handle-map.js';
import {
  actionWindowId,
  stampWindowHandle,
  windowHandleFor,
  type WindowHandleResolver,
} from '../session/window-handle-stamp.js';

/** A `LiveSession`-style emit: resolve, apply, resolve again, stamp. */
function emit(
  map: WindowHandleMap,
  action: OSAction,
  monitorId: string | undefined,
  apply: () => void,
): { handle: string | undefined; action: OSAction } {
  const resolve: WindowHandleResolver = (raw, mid) => map.resolve(raw, mid);
  const raw = actionWindowId(action);
  const priorHandle = raw ? resolve(raw, monitorId) : undefined;
  apply();
  const handle = windowHandleFor(action, resolve, monitorId, priorHandle);
  return { handle, action: stampWindowHandle(action, handle) };
}

const createAction = (windowId: string): OSAction => ({
  type: 'window.create',
  windowId,
  title: 'x',
  bounds: { x: 0, y: 0, w: 10, h: 10 },
  content: { renderer: 'text', data: '' },
});

describe('windowHandleFor', () => {
  it('resolves a create AFTER the handle is minted, not before', () => {
    const map = new WindowHandleMap();
    const { handle, action } = emit(map, createAction('preview'), '0', () => {
      map.register('preview', '0');
    });
    // The pre-apply lookup necessarily answers "preview"; sending that is what let the
    // frontend key the window by whichever monitor the tab was looking at.
    expect(handle).toBe('0/preview');
    expect((action as { windowId: string }).windowId).toBe('0/preview');
  });

  it('resolves a close BEFORE the handle is dropped, not after', () => {
    const map = new WindowHandleMap();
    map.register('memo', '1');
    const { handle, action } = emit(map, { type: 'window.close', windowId: 'memo' }, '1', () => {
      map.remove('1/memo');
    });
    expect(handle).toBe('1/memo');
    expect((action as { windowId: string }).windowId).toBe('1/memo');
  });

  it('prefers the prior handle for a non-create even when the post answer differs', () => {
    const map = new WindowHandleMap();
    map.register('notes', '0');
    const resolve: WindowHandleResolver = () => '9/wrong';
    expect(
      windowHandleFor({ type: 'window.focus', windowId: 'notes' }, resolve, '0', '0/notes'),
    ).toBe('0/notes');
  });

  it('ignores a prior handle for a create — the post-apply answer is the authority', () => {
    const map = new WindowHandleMap();
    map.register('dock', '0');
    const resolve: WindowHandleResolver = (raw, mid) => map.resolve(raw, mid);
    expect(windowHandleFor(createAction('dock'), resolve, '0', 'stale')).toBe('0/dock');
  });

  it('falls back to the raw id rather than guessing a monitor for an ambiguous id', () => {
    const map = new WindowHandleMap();
    // The same app open on two monitors: a raw lookup with no monitor cannot say which.
    map.register('storage', '0');
    map.register('storage', '1');
    const resolve: WindowHandleResolver = (raw, mid) => map.resolve(raw, mid);
    expect(windowHandleFor(createAction('storage'), resolve, undefined)).toBe('storage');
    expect(windowHandleFor(createAction('storage'), resolve, '1')).toBe('1/storage');
  });

  it('answers undefined for an action that names no window', () => {
    const resolve: WindowHandleResolver = () => 'never asked';
    expect(
      windowHandleFor({ type: 'notification.show', id: 'n1', title: 't', body: 'b' }, resolve, '0'),
    ).toBeUndefined();
  });
});

describe('stampWindowHandle', () => {
  it('carries the requestId through, so feedback stays answerable', () => {
    const action: OSAction = { type: 'window.capture', windowId: '0/preview' };
    const stamped = stampWindowHandle(action, '0/preview', 'req-1');
    expect(stamped).toEqual({ type: 'window.capture', windowId: '0/preview', requestId: 'req-1' });
  });

  it('returns the same object when there is nothing to change', () => {
    const action: OSAction = { type: 'window.close', windowId: '0/memo' };
    expect(stampWindowHandle(action, '0/memo')).toBe(action);
    expect(stampWindowHandle(action, undefined)).toBe(action);
  });
});
