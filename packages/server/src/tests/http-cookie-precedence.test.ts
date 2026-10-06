/**
 * An app's own `Cookie` header reaches the upstream as the app sent it.
 *
 * Reported as "the comment says posted, and it is not there": thesingularity-reader
 * borrows its login from the browser's cookie jar and mints a fresh anti-bot key per
 * comment, sending it both as a form field and as a cookie that DC checks against each
 * other. `safeFetch` echoed the request's own cookies back as Set-Cookie, the proxy jar
 * stored them, and on the next request the jar's copy was appended after the app's
 * header and won the duplicate. Every comment after the first went out with the first
 * comment's key, and a session the user had since replaced by logging in again.
 *
 * Runs against a real loopback server: the claim is about what arrives upstream.
 */

import { describe, it, expect, afterAll, beforeEach } from 'bun:test';
import { performFetch } from '../features/http/fetch.js';
import {
  captureResponseCookies,
  clearJar,
  jarKey,
  mergeCookieHeaders,
} from '../features/http/cookie-jar.js';
import { addAllowedDomain } from '../features/config/domains.js';

const received: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch(req) {
    received.push(req.headers.get('cookie') ?? '');
    return new Response('{"result":1}', { headers: { 'content-type': 'application/json' } });
  },
});
const url = `http://localhost:${server.port}/ajax/comment-write`;
const JAR = jarKey('ses-cookie-precedence', 'cookie-app');

afterAll(() => {
  server.stop(true);
  clearJar(JAR);
});

beforeEach(async () => {
  await addAllowedDomain('localhost');
  received.length = 0;
  clearJar(JAR);
});

const post = (cookie: string) =>
  performFetch(url, { method: 'POST', headers: { Cookie: cookie }, cookieJarKey: JAR });

describe('performFetch cookie precedence', () => {
  it('sends each request the cookies its caller set, not an earlier copy', async () => {
    await post('PHPSESSID=SESSION_A; cmtw_chk=KEY_1');
    await post('PHPSESSID=SESSION_A; cmtw_chk=KEY_2');
    await post('PHPSESSID=SESSION_B; cmtw_chk=KEY_3');

    expect(received).toEqual([
      'PHPSESSID=SESSION_A; cmtw_chk=KEY_1',
      'PHPSESSID=SESSION_A; cmtw_chk=KEY_2',
      'PHPSESSID=SESSION_B; cmtw_chk=KEY_3',
    ]);
  });

  it('still adds jar cookies the caller did not name', async () => {
    captureResponseCookies(JAR, url, { 'set-cookie': 'upstream=1; Path=/' });
    await post('mine=2');
    expect(received).toEqual(['mine=2; upstream=1']);
  });
});

describe('mergeCookieHeaders', () => {
  it("drops the jar's value for any name the caller set", () => {
    expect(mergeCookieHeaders('a=new; b=2', 'a=old; c=3')).toBe('a=new; b=2; c=3');
  });

  it('returns either side alone when the other is empty or fully shadowed', () => {
    expect(mergeCookieHeaders('', 'a=1')).toBe('a=1');
    expect(mergeCookieHeaders('a=2', 'a=1')).toBe('a=2');
  });
});
