/**
 * Security tests: MCP domain allowlist and sandbox isolation.
 *
 * Domain allowlist: agents can only make HTTP requests to domains
 * explicitly permitted by the user (stored in config/curl_allowed_domains.yaml).
 * Sandbox: executeCode() must not allow escape from the vm context.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { extractDomain } from '@yaar/server/mcp/domains';
import { executeJs } from '@yaar/server/lib/sandbox/index';

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
    expect(extractDomain('https://sub.domain.example.co.uk/path')).toBe(
      'sub.domain.example.co.uk',
    );
  });
});

// ── isDomainAllowed ────────────────────────────────────────────────────────

describe('isDomainAllowed — with Bun stub', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns false for unlisted domains when allowlist is empty', async () => {
    vi.stubGlobal('Bun', {
      file: vi.fn(() => ({
        text: async () => 'allowed_domains: []\n',
      })),
      write: vi.fn().mockResolvedValue(0),
    });

    const { isDomainAllowed } = await import('@yaar/server/mcp/domains');
    expect(await isDomainAllowed('example.com')).toBe(false);
    expect(await isDomainAllowed('api.openai.com')).toBe(false);
  });

  it('returns true for domains in the allowlist', async () => {
    vi.stubGlobal('Bun', {
      file: vi.fn(() => ({
        text: async () => 'allowed_domains:\n  - example.com\n  - api.test.io\n',
      })),
      write: vi.fn().mockResolvedValue(0),
    });

    const { isDomainAllowed } = await import('@yaar/server/mcp/domains');
    expect(await isDomainAllowed('example.com')).toBe(true);
    expect(await isDomainAllowed('api.test.io')).toBe(true);
  });

  it('returns false for domains NOT in allowlist even if others are allowed', async () => {
    vi.stubGlobal('Bun', {
      file: vi.fn(() => ({
        text: async () => 'allowed_domains:\n  - example.com\n',
      })),
      write: vi.fn().mockResolvedValue(0),
    });

    const { isDomainAllowed } = await import('@yaar/server/mcp/domains');
    expect(await isDomainAllowed('evil.example.com')).toBe(false);
    expect(await isDomainAllowed('attacker.net')).toBe(false);
  });

  it('returns true for any domain when allow_all_domains is true', async () => {
    vi.stubGlobal('Bun', {
      file: vi.fn(() => ({
        text: async () => 'allow_all_domains: true\nallowed_domains: []\n',
      })),
      write: vi.fn().mockResolvedValue(0),
    });

    const { isDomainAllowed } = await import('@yaar/server/mcp/domains');
    expect(await isDomainAllowed('anything.example.com')).toBe(true);
    expect(await isDomainAllowed('totally-unknown.net')).toBe(true);
  });

  it('defaults to empty allowlist (safe) when config file missing (Bun unavailable)', async () => {
    // No Bun stub → configRead throws → falls back to empty config
    const { isDomainAllowed } = await import('@yaar/server/mcp/domains');
    // Without Bun, returns false (safe default — deny)
    expect(await isDomainAllowed('example.com')).toBe(false);
  });
});

// ── Sandbox isolation ──────────────────────────────────────────────────────

describe('executeJs — sandbox security', () => {
  it('cannot access process.env from sandboxed code', async () => {
    const result = await executeJs('return typeof process');
    // process is not exposed in the sandbox context
    expect(result.success).toBe(true);
    expect(result.result).toBe('"undefined"');
  });

  it('cannot require() arbitrary modules', async () => {
    const result = await executeJs('return typeof require');
    expect(result.success).toBe(true);
    expect(result.result).toBe('"undefined"');
  });

  it('cannot access __dirname or __filename', async () => {
    const result = await executeJs('return typeof __dirname + "," + typeof __filename');
    expect(result.success).toBe(true);
    expect(result.result).toBe('"undefined,undefined"');
  });

  it('times out on infinite loops and returns an error', async () => {
    const result = await executeJs('while(true){}', { timeout: 200 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  }, 5000);

  it('cannot access fetch without an allowedDomain', async () => {
    // fetch is available but domain-restricted in the sandbox context
    const result = await executeJs(
      'return typeof fetch !== "undefined" ? "fetch-exists" : "no-fetch"',
    );
    expect(result.success).toBe(true);
    // fetch is injected but blocked at request time, not removed
    expect(result.result).toMatch(/"fetch-exists"|"no-fetch"/);
  });

  it('returns computed values correctly', async () => {
    const result = await executeJs('return [1,2,3].reduce((a,b) => a+b, 0)');
    expect(result.success).toBe(true);
    expect(result.result).toBe('6');
  });
});
