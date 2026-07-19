/**
 * Integration tests: POST /api/fetch is an app door, not an open proxy.
 *
 * The transparent fetch proxy and `invoke('yaar://http')` reach the identical
 * performFetch(), so they must agree on who may call it. They did not: the verb
 * route resolved a principal and checked `yaar://http`, while this route read the
 * iframe token opportunistically and checked nothing. These are the acceptance
 * criteria for closing that gap.
 *
 * A permission denial short-circuits before performFetch. The cases that *do* get
 * past the gate reach it and fail on DNS: the target is under `.invalid`, which
 * RFC 2606 reserves as permanently non-resolvable, so no test touches a real host.
 */

import { describe, it, expect } from 'bun:test';
import { generateIframeToken } from '@yaar/server/http/iframe-tokens';
import { makeRequest } from '../helpers/fetch-harness.js';

const TARGET = 'https://example.invalid/data.json';

/** The message requirePermission produces for this route. */
const PERMISSION_DENIED = 'Not permitted: invoke yaar://http';

function proxyRequest(token?: string) {
  return makeRequest('/api/fetch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-iframe-token': token } : {}),
    },
    body: JSON.stringify({ url: TARGET }),
  });
}

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: string };
  return body.error ?? '';
}

describe('POST /api/fetch — principal gate', () => {
  it('refuses a request bearing no iframe token', async () => {
    // No token resolves to the *host*. The desktop drives the server over the
    // WebSocket and never posts here, so a host request on this route is either a
    // mistake or an app that dropped its token to shed its permissions.
    const res = await proxyRequest();
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toContain('Invalid or missing iframe token');
  });

  it('refuses an invalid or expired token instead of downgrading it', async () => {
    // The old route ignored a token it could not validate and proceeded anonymously,
    // which made expiry a silent *loss of attribution* rather than a failure.
    const res = await proxyRequest('not-a-real-token');
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toContain('Invalid or expired iframe token');
  });

  it('refuses an app that did not declare yaar://http', async () => {
    const token = generateIframeToken('win-notes', 'ses-test', {
      appId: 'notes',
      permissions: ['yaar://apps/self/storage/'],
    });
    const res = await proxyRequest(token);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toContain(PERMISSION_DENIED);
  });

  it('admits an app that declared yaar://http', async () => {
    const token = generateIframeToken('win-dock', 'ses-test', {
      appId: 'dock',
      permissions: ['yaar://apps/self/storage/', 'yaar://http'],
    });
    const res = await proxyRequest(token);
    // Past the permission gate. What stops it now is the transport — `.invalid` is
    // guaranteed non-resolvable (RFC 2606) — not authorization. Asserting on the
    // absence of the denial rather than on a specific downstream status keeps this
    // independent of whichever allowlist the test environment happens to carry.
    expect(await errorOf(res)).not.toContain(PERMISSION_DENIED);
  });

  it('accepts the trailing-slash spelling of the permission', async () => {
    // Both `yaar://http` and `yaar://http/` appear in shipped app.json files and
    // uriMatches() honours each. A sweep that "fixed" one spelling would be churn.
    const token = generateIframeToken('win-dc', 'ses-test', {
      appId: 'dc-comics',
      permissions: ['yaar://http/'],
    });
    const res = await proxyRequest(token);
    expect(await errorOf(res)).not.toContain(PERMISSION_DENIED);
  });

  it('lets a plain (non-app) iframe window through the permission gate', async () => {
    // An AI-generated window has no app.json, so it has nothing to declare
    // `yaar://http` in. Gating it would deny cross-origin fetch with no way to opt
    // in. SSRF validation and the domain allowlist still apply — those are the
    // network gate; the permission is a *declaration* only apps can make.
    const token = generateIframeToken('win-plain', 'ses-test', {});
    const res = await proxyRequest(token);
    expect(await errorOf(res)).not.toContain(PERMISSION_DENIED);
  });
});

describe('POST /api/fetch — identity comes from the token', () => {
  it('does not let a caller-supplied sessionId reach the gate', async () => {
    // The body's sessionId used to pick which session saw the domain-approval
    // dialog, so an app could raise a prompt in a session it had no part in. The
    // route now derives session and cookie-jar identity from the token alone.
    //
    // This asserts the weaker half of that: naming another session is not an escape
    // hatch around the permission gate. The stronger half — that the dialog and the
    // cookie jar are scoped to the *token's* session — is not observable through the
    // HTTP response, since ensureDomainAllowed's routing leaves no trace in it.
    // Proving that needs a session-hub-level test, not a request-level one.
    const token = generateIframeToken('win-notes', 'ses-test', {
      appId: 'notes',
      permissions: ['yaar://apps/self/storage/'],
    });
    const res = await makeRequest('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-iframe-token': token },
      body: JSON.stringify({ url: TARGET, sessionId: 'ses-somebody-else' }),
    });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toContain(PERMISSION_DENIED);
  });

  it('still validates the request body before the gate', async () => {
    const token = generateIframeToken('win-dock', 'ses-test', {
      appId: 'dock',
      permissions: ['yaar://http'],
    });
    const res = await makeRequest('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-iframe-token': token },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('url');
  });
});
