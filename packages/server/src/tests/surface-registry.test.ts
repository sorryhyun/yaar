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
    surfaces.record({ type: 'notification.show', id: 'n1', title: 'One', body: '' });
    surfaces.record({ type: 'notification.show', id: 'n2', title: 'Two', body: '' });

    surfaces.answered('n1');

    expect(surfaces.snapshot().map((a) => ('id' in a ? a.id : undefined))).toEqual(['n2']);
  });

  it('forgets a notification an agent dismissed', () => {
    const surfaces = new SurfaceRegistry();
    surfaces.record({ type: 'notification.show', id: 'n1', title: 'One', body: '' });
    surfaces.record({ type: 'notification.dismiss', id: 'n1' });
    expect(surfaces.snapshot()).toEqual([]);
  });
});
