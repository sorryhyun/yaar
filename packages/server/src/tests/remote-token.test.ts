/**
 * `YAAR_REMOTE_TOKEN` — the launcher-supplied remote token.
 *
 * The length floor is the part worth pinning: in remote mode the default tunnel puts a
 * public URL in front of this token, so silently adopting a short one would turn a typo
 * into an open door. Under the floor the value must be ignored, not trusted.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { generateRemoteToken, getRemoteToken } from '../http/auth.js';

const original = process.env.YAAR_REMOTE_TOKEN;

afterEach(() => {
  if (original === undefined) delete process.env.YAAR_REMOTE_TOKEN;
  else process.env.YAAR_REMOTE_TOKEN = original;
});

describe('generateRemoteToken', () => {
  test('adopts a supplied token of sufficient length', () => {
    const supplied = 'a'.repeat(43);
    process.env.YAAR_REMOTE_TOKEN = supplied;
    expect(generateRemoteToken()).toBe(supplied);
    expect(getRemoteToken()).toBe(supplied);
  });

  test('ignores a supplied token that is too short', () => {
    process.env.YAAR_REMOTE_TOKEN = 'letmein';
    const token = generateRemoteToken();
    expect(token).not.toBe('letmein');
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  test('generates a distinct random token when none is supplied', () => {
    delete process.env.YAAR_REMOTE_TOKEN;
    const first = generateRemoteToken();
    const second = generateRemoteToken();
    expect(first).not.toBe(second);
    // base64url only — the token rides in a URL fragment and a query param.
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
