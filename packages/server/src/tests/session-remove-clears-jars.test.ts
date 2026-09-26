/**
 * Removing a session drops its cookie jars.
 *
 * Iframe-token revocation clears a per-app jar when its last token goes, but nothing
 * cleared the session's host jar (`sessionId:__host__`) or an app jar whose token was
 * still live when the session went — so every evicted session leaked its cookies.
 */

import { describe, it, expect } from 'bun:test';
import { captureResponseCookies, getCookieHeader, jarKey } from '../features/http/cookie-jar.js';
import { getSessionHub } from '../session/session-hub.js';
import type { SessionId } from '../session/types.js';

const URL_UNDER_TEST = 'https://example.com/';

function seed(key: string) {
  captureResponseCookies(key, URL_UNDER_TEST, { 'set-cookie': 'sid=abc; Path=/' });
}

describe('SessionHub.remove', () => {
  it("clears every cookie jar of the removed session, and only that session's", async () => {
    const hub = getSessionHub();
    const gone = 'ses-jar-remove-a' as SessionId;
    const kept = 'ses-jar-remove-b' as SessionId;
    hub.attach(gone, {});

    seed(jarKey(gone));
    seed(jarKey(gone, 'some-app'));
    seed(jarKey(kept));

    await hub.remove(gone);

    expect(getCookieHeader(jarKey(gone), URL_UNDER_TEST)).toBeUndefined();
    expect(getCookieHeader(jarKey(gone, 'some-app'), URL_UNDER_TEST)).toBeUndefined();
    expect(getCookieHeader(jarKey(kept), URL_UNDER_TEST)).toBe('sid=abc');
  });
});
