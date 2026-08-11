/**
 * Codex CLI version policy.
 *
 * The load-bearing assertion here is the last one: `CODEX_GENERATED_FROM >= CODEX_MIN_VERSION`.
 * Raising the floor without re-running `make codex-types` claims we support a protocol we have
 * never generated against, and nothing else in the build notices — the bindings still compile,
 * they just describe a different CLI than the one we now demand. The parser cases pin the two
 * real-world strings the runtime gates read, captured from codex 0.145.0.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import {
  assertSupportedCodex,
  CODEX_MIN_VERSION,
  CODEX_UPGRADE_HINT,
  CodexVersionError,
  isAtLeast,
  parseCodexUserAgent,
  parseVersion,
  parseVersionOutput,
} from '../providers/codex/version.js';
import { CODEX_GENERATED_FROM } from '../providers/codex/generated/codex-version.js';

describe('parseVersion', () => {
  it('reads numeric parts and drops prerelease/build suffixes', () => {
    expect(parseVersion('0.145.0')).toEqual([0, 145, 0]);
    expect(parseVersion('1.0.0-beta.1')).toEqual([1, 0, 0]);
    expect(parseVersion('1.0.0+build.5')).toEqual([1, 0, 0]);
    expect(parseVersion('  0.145.0  ')).toEqual([0, 145, 0]);
  });

  it('returns null for anything non-numeric', () => {
    expect(parseVersion('not-a-version')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('0.x.1')).toBeNull();
  });
});

describe('isAtLeast', () => {
  it('accepts equal and newer, rejects older', () => {
    expect(isAtLeast('0.145.0', '0.145.0')).toBe(true);
    expect(isAtLeast('0.145.1', '0.145.0')).toBe(true);
    expect(isAtLeast('0.146.0', '0.145.0')).toBe(true);
    expect(isAtLeast('1.0.0', '0.145.0')).toBe(true);
    expect(isAtLeast('0.144.9', '0.145.0')).toBe(false);
    expect(isAtLeast('0.9.0', '0.145.0')).toBe(false);
  });

  it('compares segments numerically, not as strings', () => {
    // The failure this exists for: "0.99.0" > "0.145.0" in string order.
    expect(isAtLeast('0.99.0', '0.145.0')).toBe(false);
    expect(isAtLeast('0.145.10', '0.145.9')).toBe(true);
  });

  it('treats a missing segment as zero', () => {
    expect(isAtLeast('0.145', '0.145.0')).toBe(true);
    expect(isAtLeast('0.145', '0.145.1')).toBe(false);
  });

  it('returns null — "cannot tell" — for unparseable input', () => {
    // Distinct from false on purpose: the runtime gates fail open on null and closed on false.
    expect(isAtLeast('unknown', '0.145.0')).toBeNull();
    expect(isAtLeast('0.145.0', 'unknown')).toBeNull();
  });
});

describe('parseVersionOutput', () => {
  it('reads the version from real `codex --version` output', () => {
    expect(parseVersionOutput('codex-cli 0.145.0\n')).toBe('0.145.0');
  });

  it('returns null when no version is present', () => {
    expect(parseVersionOutput('command not found')).toBeNull();
    expect(parseVersionOutput('')).toBeNull();
  });
});

describe('parseCodexUserAgent', () => {
  it('reads the version from a real initialize userAgent', () => {
    // Captured verbatim from codex 0.145.0. The leading name is our own clientInfo.name
    // echoed back; the version beside it is the app-server's.
    const ua = 'yaar/0.145.0 (Mac OS 26.5.2; arm64) Apple_Terminal/470.2 (yaar; 1.0.0)';
    expect(parseCodexUserAgent(ua)).toBe('0.145.0');
  });

  it('anchors to the leading name/version pair, not any later one', () => {
    // The trailing `(yaar; 1.0.0)` is the *client* version — matching it would compare
    // YAAR's own version against the codex floor.
    expect(parseCodexUserAgent('yaar/0.146.0 (Linux) Terminal/1.2.3 (yaar; 1.0.0)')).toBe(
      '0.146.0',
    );
  });

  it('returns null on a shape it does not recognize', () => {
    expect(parseCodexUserAgent('some-agent (no version)')).toBeNull();
    expect(parseCodexUserAgent('')).toBeNull();
  });
});

describe('CodexVersionError', () => {
  it('names both versions and the upgrade command', () => {
    const err = new CodexVersionError('0.144.0');
    expect(err.actual).toBe('0.144.0');
    expect(err.required).toBe(CODEX_MIN_VERSION);
    expect(err.message).toContain('0.144.0');
    expect(err.message).toContain(CODEX_MIN_VERSION);
    expect(err.message).toContain(CODEX_UPGRADE_HINT);
  });
});

describe('assertSupportedCodex', () => {
  const ua = (v: string) => `yaar/${v} (Mac OS 26.5.2; arm64) Apple_Terminal/470.2 (yaar; 1.0.0)`;
  const silent = () => {};

  it('accepts the floor and anything newer', () => {
    expect(() => assertSupportedCodex(ua(CODEX_MIN_VERSION), silent)).not.toThrow();
    expect(() => assertSupportedCodex(ua('0.146.0'), silent)).not.toThrow();
    expect(() => assertSupportedCodex(ua('1.0.0'), silent)).not.toThrow();
  });

  it('throws CodexVersionError below the floor', () => {
    expect(() => assertSupportedCodex(ua('0.144.0'), silent)).toThrow(CodexVersionError);
    expect(() => assertSupportedCodex(ua('0.99.0'), silent)).toThrow(CodexVersionError);
    try {
      assertSupportedCodex(ua('0.144.0'), silent);
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CodexVersionError);
      expect((err as CodexVersionError).actual).toBe('0.144.0');
    }
  });

  it('fails open, with a warning, on an unrecognized userAgent', () => {
    // OpenAI owns this format; a cosmetic change there must not brick a working install.
    const warnings: string[] = [];
    expect(() =>
      assertSupportedCodex('rewritten-format v2', (m) => warnings.push(m)),
    ).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('rewritten-format v2');
  });
});

describe('generated bindings provenance', () => {
  it('was generated from a CLI that satisfies the floor', () => {
    // Fails when CODEX_MIN_VERSION is raised without re-running `make codex-types`.
    expect(isAtLeast(CODEX_GENERATED_FROM, CODEX_MIN_VERSION)).toBe(true);
  });
});

describe('the @openai/codex peer range', () => {
  // `getCodexSpawnArgs()` prefers a codex vendored into node_modules, and the range below is
  // the only thing telling a user which versions that opt-in may resolve to. Stated twice, it
  // would drift: raising CODEX_MIN_VERSION while the peer range still admits the old CLI means
  // `bun add @openai/codex` can install a binary the three runtime gates then refuse.
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

  it('admits exactly the versions CODEX_MIN_VERSION admits', () => {
    expect(pkg.peerDependencies?.['@openai/codex']).toBe(`>=${CODEX_MIN_VERSION}`);
  });

  it('is optional, so installing YAAR never downloads a 275 MB binary', () => {
    // The whole reason it is a peer and not a dependency: optional peers are not
    // auto-installed, so a contributor on the Claude provider pays nothing for it.
    expect(pkg.peerDependenciesMeta?.['@openai/codex']?.optional).toBe(true);
  });
});
