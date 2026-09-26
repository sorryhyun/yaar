/**
 * `getEnvInt` falls back on garbage instead of returning `NaN`.
 *
 * `NaN` is not a loud failure: `MAX_AGENTS=abc` reached the limiter as a limit every
 * `<` comparison is false against, so the cap silently stopped meaning anything.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { getEnvInt } from '../config/env.js';

const KEY = 'YAAR_TEST_GET_ENV_INT';

afterEach(() => {
  delete process.env[KEY];
});

describe('getEnvInt', () => {
  it('returns the default when unset', () => {
    expect(getEnvInt(KEY, 7)).toBe(7);
  });

  it('parses a valid integer', () => {
    process.env[KEY] = '42';
    expect(getEnvInt(KEY, 7)).toBe(42);
  });

  it('keeps zero, which is a real value and not "unset"', () => {
    process.env[KEY] = '0';
    expect(getEnvInt(KEY, 7)).toBe(0);
  });

  it.each(['abc', '', '   ', 'NaN'])('falls back to the default on %p', (raw) => {
    process.env[KEY] = raw;
    expect(getEnvInt(KEY, 7)).toBe(7);
  });
});
