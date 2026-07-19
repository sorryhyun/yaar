/**
 * `delete yaar://http` — the cookie jar's logout door.
 *
 * Cross-origin requests are jarred per (session, app). Until this verb existed the
 * jar's only lifecycle was the iframe token's 24-hour expiry, so an app with a login
 * could not fully log out: clearing its own stored session left the upstream
 * service's cookies alive server-side, and later "anonymous" requests still carried
 * them.
 *
 * These assert on the jar directly rather than through performFetch, so no test
 * touches the network.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  captureResponseCookies,
  getCookieHeader,
  clearJar,
  jarKey,
} from '../features/http/cookie-jar.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import { initRegistry } from '../handlers/index.js';
import type { VerbResult } from '../handlers/uri-registry.js';
import type { SessionId } from '../session/types.js';

const URL_UNDER_TEST = 'https://example.com/account';
const SESSION = 'ses-jar-test';

/** Seed a jar with a session cookie the way a real upstream response would. */
function seedJar(key: string) {
  captureResponseCookies(key, URL_UNDER_TEST, {
    'set-cookie': 'SESSIONID=secret-value; Path=/',
  });
}

function asApp(appId: string | undefined, fn: () => Promise<unknown>) {
  return runWithAgentContext(
    {
      agentId: `iframe:${appId ?? 'unknown'}`,
      sessionId: SESSION as SessionId,
      appId,
    },
    fn,
  );
}

describe('delete yaar://http', () => {
  beforeEach(() => {
    clearJar(jarKey(SESSION, 'reader'));
    clearJar(jarKey(SESSION, 'other'));
  });

  it("clears the calling app's stored cookies", async () => {
    const key = jarKey(SESSION, 'reader');
    seedJar(key);
    expect(getCookieHeader(key, URL_UNDER_TEST)).toContain('SESSIONID=secret-value');

    const registry = initRegistry();
    await asApp('reader', () => registry.execute('delete', 'yaar://http'));

    // The whole point: after logout the proxy no longer speaks for the old session.
    expect(getCookieHeader(key, URL_UNDER_TEST)).toBeUndefined();
  });

  it("clears only the caller's jar, not another app's", async () => {
    // The key is derived from the caller's own context and never from a payload,
    // so one app's logout must not log another app out of the same service.
    const mine = jarKey(SESSION, 'reader');
    const theirs = jarKey(SESSION, 'other');
    seedJar(mine);
    seedJar(theirs);

    const registry = initRegistry();
    await asApp('reader', () => registry.execute('delete', 'yaar://http'));

    expect(getCookieHeader(mine, URL_UNDER_TEST)).toBeUndefined();
    expect(getCookieHeader(theirs, URL_UNDER_TEST)).toContain('SESSIONID=secret-value');
  });

  it('targets the same key the proxy route writes through', async () => {
    // proxy.ts builds jarKey(principal.sessionId, principal.appId). If this verb
    // derived the key any other way it would clear an empty jar and silently
    // "succeed" while the real cookies survived.
    const key = jarKey(SESSION, 'reader');
    seedJar(key);

    const registry = initRegistry();
    const result = (await asApp('reader', () =>
      registry.execute('delete', 'yaar://http'),
    )) as VerbResult;

    expect(result.isError).toBeFalsy();
    expect(getCookieHeader(key, URL_UNDER_TEST)).toBeUndefined();
  });

  it('fails rather than guessing when there is no session context', async () => {
    const registry = initRegistry();
    const result = await registry.execute('delete', 'yaar://http');
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('session');
  });
});
