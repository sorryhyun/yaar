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

describe('isDomainAllowed — with storage mock', () => {
  it('returns false for unlisted domains when allowlist is empty', async () => {
    mock.module('@yaar/server/storage/index', () => ({
      configRead: mock(() => Promise.resolve({ success: true, content: 'allowed_domains: []\n' })),
      configWrite: mock(() => Promise.resolve({ success: true })),
    }));

    const { isDomainAllowed } = await import('@yaar/server/features/config/domains');
    expect(await isDomainAllowed('example.com')).toBe(false);
    expect(await isDomainAllowed('api.openai.com')).toBe(false);
  });

  it('returns true for domains in the allowlist', async () => {
    mock.module('@yaar/server/storage/index', () => ({
      configRead: mock(() =>
        Promise.resolve({
          success: true,
          content: 'allowed_domains:\n  - example.com\n  - api.test.io\n',
        }),
      ),
      configWrite: mock(() => Promise.resolve({ success: true })),
    }));

    const { isDomainAllowed } = await import('@yaar/server/features/config/domains');
    expect(await isDomainAllowed('example.com')).toBe(true);
    expect(await isDomainAllowed('api.test.io')).toBe(true);
  });

  it('returns false for domains NOT in allowlist even if others are allowed', async () => {
    mock.module('@yaar/server/storage/index', () => ({
      configRead: mock(() =>
        Promise.resolve({ success: true, content: 'allowed_domains:\n  - example.com\n' }),
      ),
      configWrite: mock(() => Promise.resolve({ success: true })),
    }));

    const { isDomainAllowed } = await import('@yaar/server/features/config/domains');
    expect(await isDomainAllowed('evil.example.com')).toBe(false);
    expect(await isDomainAllowed('attacker.net')).toBe(false);
  });

  it('returns true for any domain when allow_all_domains is true', async () => {
    mock.module('@yaar/server/storage/index', () => ({
      configRead: mock(() =>
        Promise.resolve({
          success: true,
          content: 'allow_all_domains: true\nallowed_domains: []\n',
        }),
      ),
      configWrite: mock(() => Promise.resolve({ success: true })),
    }));

    const { isDomainAllowed } = await import('@yaar/server/features/config/domains');
    expect(await isDomainAllowed('anything.example.com')).toBe(true);
    expect(await isDomainAllowed('totally-unknown.net')).toBe(true);
  });

  it('defaults to empty allowlist (safe) when config read fails', async () => {
    mock.module('@yaar/server/storage/index', () => ({
      configRead: mock(() => Promise.resolve({ success: false, error: 'not found' })),
      configWrite: mock(() => Promise.resolve({ success: true })),
    }));

    const { isDomainAllowed } = await import('@yaar/server/features/config/domains');
    // Falls back to default empty config → deny
    expect(await isDomainAllowed('example.com')).toBe(false);
  });
});
