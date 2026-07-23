/**
 * Security tests: MCP domain allowlist and sandbox isolation.
 *
 * Domain allowlist: agents can only make HTTP requests to domains
 * explicitly permitted by the user (stored in config/curl_allowed_domains.yaml).
 * Sandbox: executeCode() must not allow escape from the vm context.
 */

import { describe, it, expect, mock } from 'bun:test';
import { extractDomain } from '@yaar/server/features/config/domains';

// ── extractDomain ──────────────────────────────────────────────────────────

describe('extractDomain', () => {
  it('extracts hostname from a simple URL', () => {
    expect(extractDomain('https://example.com/api/data')).toBe('example.com');
  });

  it('extracts hostname without port', () => {
    expect(extractDomain('http://api.example.com:3000/path')).toBe('api.example.com');
  });

  it('returns empty string for invalid URLs', () => {
    expect(extractDomain('not-a-url')).toBe('');
    expect(extractDomain('')).toBe('');
  });

  it('handles subdomains correctly', () => {
    expect(extractDomain('https://sub.domain.example.co.uk/path')).toBe('sub.domain.example.co.uk');
  });
});

// ── isDomainAllowed ────────────────────────────────────────────────────────

/**
 * Serve `domains.ts` a fixture allowlist, isolated from the previous test's.
 *
 * Two things here are load-bearing.
 *
 * `mock.module` replaces a module *wholesale*, so every export `domains.ts` pulls
 * from storage has to appear below. Omitting one is not a silent partial mock: the
 * module fails to link with "Export named ... not found" the moment it is imported
 * against the replacement.
 *
 * The mtime matters as much as the content. `readConfig` caches the parsed
 * allowlist keyed on the config file's mtime, and re-reads only when that mtime
 * moves. Leaving `configStatMtime` unmocked returned the *real* config file's
 * mtime — one constant for the whole run — so the first fixture to load was served
 * to every later test and `configRead` was never called again. That is what made
 * two of these fail, and, worse, made two others pass while asserting nothing. A
 * fresh mtime per install is what actually separates them.
 */
let fixtureMtime = 0;
function mockAllowlistStorage(content: string | null): void {
  fixtureMtime += 1000;
  mock.module('@yaar/server/storage/index', () => ({
    configRead: mock(() =>
      Promise.resolve(
        content === null ? { success: false, error: 'not found' } : { success: true, content },
      ),
    ),
    configWrite: mock(() => Promise.resolve({ success: true })),
    configStatMtime: mock(() => Promise.resolve(fixtureMtime)),
  }));
}

describe('isDomainAllowed — with storage mock', () => {
  it('returns false for unlisted domains when allowlist is empty', async () => {
    mockAllowlistStorage('allowed_domains: []\n');

    const { isDomainAllowed } = await import('@yaar/server/features/config/domains');
    expect(await isDomainAllowed('example.com')).toBe(false);
    expect(await isDomainAllowed('api.openai.com')).toBe(false);
  });

  it('returns true for domains in the allowlist', async () => {
    mockAllowlistStorage('allowed_domains:\n  - example.com\n  - api.test.io\n');

    const { isDomainAllowed } = await import('@yaar/server/features/config/domains');
    expect(await isDomainAllowed('example.com')).toBe(true);
    expect(await isDomainAllowed('api.test.io')).toBe(true);
  });

  it('returns false for domains NOT in allowlist even if others are allowed', async () => {
    mockAllowlistStorage('allowed_domains:\n  - example.com\n');

    const { isDomainAllowed } = await import('@yaar/server/features/config/domains');
    expect(await isDomainAllowed('evil.example.com')).toBe(false);
    expect(await isDomainAllowed('attacker.net')).toBe(false);
  });

  it('returns true for any domain when allow_all_domains is true', async () => {
    mockAllowlistStorage('allow_all_domains: true\nallowed_domains: []\n');

    const { isDomainAllowed } = await import('@yaar/server/features/config/domains');
    expect(await isDomainAllowed('anything.example.com')).toBe(true);
    expect(await isDomainAllowed('totally-unknown.net')).toBe(true);
  });

  it('defaults to empty allowlist (safe) when config read fails', async () => {
    mockAllowlistStorage(null);

    const { isDomainAllowed } = await import('@yaar/server/features/config/domains');
    // Falls back to default empty config → deny
    expect(await isDomainAllowed('example.com')).toBe(false);
  });

  it('serves a later fixture instead of the cached one when the mtime moves', async () => {
    // The regression these tests hid: a stale cache is indistinguishable from a
    // correct answer whenever the fixture and the cache agree. Deny then allow the
    // *same* domain, so only a genuine re-read can produce both results.
    mockAllowlistStorage('allowed_domains: []\n');
    const first = await import('@yaar/server/features/config/domains');
    expect(await first.isDomainAllowed('rotating.example')).toBe(false);

    mockAllowlistStorage('allowed_domains:\n  - rotating.example\n');
    const second = await import('@yaar/server/features/config/domains');
    expect(await second.isDomainAllowed('rotating.example')).toBe(true);
  });
});
