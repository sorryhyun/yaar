/**
 * A notification the user dismissed must not come back on the next snapshot.
 *
 * The user's dismiss arrives as a `notification.dismiss` interaction, not as an action, so
 * it never passes through `record()` — it used to be dropped, and every reload re-showed
 * every notification the user had already closed.
 */
import { describe, expect, it } from 'bun:test';
import { SurfaceRegistry } from '../session/surface-state.js';

describe('SurfaceRegistry', () => {
  it('forgets a notification the user dismissed', () => {
    const surfaces = new SurfaceRegistry();
    surfaces.record({ type: 'notification.show', id: 'n1', title: 'One', body: '' }, '0');
    surfaces.record({ type: 'notification.show', id: 'n2', title: 'Two', body: '' }, '1');

    surfaces.answered('n1');

    expect(surfaces.snapshot().map((a) => ('id' in a ? a.id : undefined))).toEqual(['n2']);
  });

  it('forgets a notification an agent dismissed', () => {
    const surfaces = new SurfaceRegistry();
    surfaces.record({ type: 'notification.show', id: 'n1', title: 'One', body: '' });
    surfaces.record({ type: 'notification.dismiss', id: 'n1' });
    expect(surfaces.snapshot()).toEqual([]);
  });

  it('keeps only the newest notification per monitor, stamped with its monitor', () => {
    const surfaces = new SurfaceRegistry();
    surfaces.record({ type: 'notification.show', id: 'a', title: 'A', body: '' }, '0');
    surfaces.record({ type: 'notification.show', id: 'b', title: 'B', body: '' }, '1');
    surfaces.record({ type: 'notification.show', id: 'c', title: 'C', body: '' }, '0');

    expect(surfaces.snapshot()).toEqual([
      { type: 'notification.show', id: 'b', title: 'B', body: '', monitorId: '1' },
      { type: 'notification.show', id: 'c', title: 'C', body: '', monitorId: '0' },
    ]);
  });

  it('updates a notification in place when the same id is shown again', () => {
    const surfaces = new SurfaceRegistry();
    surfaces.record({ type: 'notification.show', id: 'a', title: 'Old', body: '' }, '0');
    surfaces.record({ type: 'notification.show', id: 'a', title: 'New', body: '' }, '0');
    expect(surfaces.snapshot()).toEqual([
      { type: 'notification.show', id: 'a', title: 'New', body: '', monitorId: '0' },
    ]);
  });
});
