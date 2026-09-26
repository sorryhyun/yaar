/**
 * The boot-time session logger belongs to one session.
 *
 * `lifecycle.ts` mints a `SessionLogger` eagerly so the first session's interactions are
 * logged from the start, and the WebSocket layer used to hand it to *every* session the
 * hub created. A second tab whose stale id the hub did not know, or the replacement for an
 * evicted session, therefore wrote into the boot session's log directory — and went on
 * writing through it after the first session's cleanup had disposed it.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { getSessionHub } from '../../session/session-hub.js';
import { getBroadcastCenter } from '../../session/broadcast-center.js';
import { boot, type Harness } from './harness/boot.js';
import { FakeClient } from './harness/fake-client.js';

let harness: Harness | undefined;
let other: FakeClient | undefined;

afterEach(async () => {
  if (other) {
    await other.close();
    getBroadcastCenter().unsubscribe(other.data.connectionId);
    await getSessionHub().remove(other.data.sessionId as string);
    other = undefined;
  }
  await harness?.dispose();
  harness = undefined;
});

describe('boot session logger', () => {
  it('goes to the first session created and not to the next one', async () => {
    const h = await boot();
    harness = h;
    const bootLogger = h.session.getSessionLogger();
    expect(bootLogger).not.toBeNull();

    other = new FakeClient(h.handlers, 'ses-some-other-tab', '0');
    await other.open();
    const second = getSessionHub().get('ses-some-other-tab');
    expect(second).toBeDefined();
    expect(second).not.toBe(h.session);

    // RED before the fix: the second session was handed the boot logger too.
    expect(second!.getSessionLogger()).not.toBe(bootLogger);
    // Rejoining the first session does not hand it anything new either.
    await h.connect('0');
    expect(h.session.getSessionLogger()).toBe(bootLogger);
  });
});
