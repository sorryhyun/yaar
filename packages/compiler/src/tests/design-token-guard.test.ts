import { describe, expect, test } from 'bun:test';
import { knownTokens, scanTokens, suggestToken } from '../design-token-guard.js';
import { describeDesignTokens } from '../design-tokens.js';

const file = (text: string, path = 'src/main.ts') => ({ path, text });

describe('the guard and the prompt agree', () => {
  // The whole point of generating both from the CSS: what the compiler *rejects*
  // and what it *tells an agent exists* can never disagree. A hand-written list
  // is exactly how devtools ended up being told `design-tokens` was describable
  // when it was not, and guessing `--yaar-space-2` from its priors.
  test('every token the guard accepts is advertised to agents', () => {
    const reference = describeDesignTokens();
    const missing = [...knownTokens()].filter((t) => !reference.includes(t));
    expect(missing).toEqual([]);
  });

  test('every token advertised to agents passes the guard', () => {
    const advertised = [...describeDesignTokens().matchAll(/(--yaar-[a-z0-9-]+):/g)].map(
      (m) => m[1],
    );
    expect(advertised.length).toBeGreaterThan(20);
    expect(scanTokens([file(advertised.map((t) => `var(${t})`).join(';'))])).toEqual([]);
  });

  test('the utility class list is complete, not just the line-leading ones', () => {
    // `.y-flex{...}.y-flex-col{...}` share a line; an anchored regex silently
    // dropped every class but the first, advertising a smaller API than exists.
    const reference = describeDesignTokens();
    for (const cls of ['y-flex-col', 'y-gap-2', 'y-p-4', 'y-btn-danger', 'y-clamp-3']) {
      expect(reference).toContain(`.${cls}`);
    }
  });
});

describe('knownTokens', () => {
  test('derives the token set from the injected CSS', () => {
    const tokens = knownTokens();
    expect(tokens.has('--yaar-sp-2')).toBe(true);
    expect(tokens.has('--yaar-bg-surface')).toBe(true);
    expect(tokens.has('--yaar-space-2')).toBe(false);
    expect(tokens.has('--yaar-bg-elevated')).toBe(false);
  });
});

describe('scanTokens', () => {
  test('flags a token that is never defined', () => {
    const findings = scanTokens([file('const s = `padding: var(--yaar-space-2)`;')]);
    expect(findings).toHaveLength(1);
    expect(findings[0].token).toBe('--yaar-space-2');
    expect(findings[0].suggestion).toBe('--yaar-sp-2');
  });

  test('suggests the real token for the observed near-misses', () => {
    const findings = scanTokens([file('a{background:var(--yaar-bg-elevated)}', 'src/styles.css')]);
    expect(findings[0].suggestion).toBe('--yaar-bg-surface');
  });

  test('accepts every token the compiler injects', () => {
    const usages = [...knownTokens()].map((t) => `var(${t})`).join(';');
    expect(scanTokens([file(usages)])).toEqual([]);
  });

  test('a fallback makes an unknown token legal — that is what it is for', () => {
    const findings = scanTokens([file('a{background:var(--yaar-bg-hover, rgba(0,0,0,.04))}')]);
    expect(findings).toEqual([]);
  });

  test('the same token without a fallback is a defect', () => {
    const findings = scanTokens([file('a{background:var(--yaar-bg-hover)}')]);
    expect(findings).toHaveLength(1);
    expect(findings[0].token).toBe('--yaar-bg-hover');
    // Edit distance alone would say `--yaar-border` (5 edits, vs 8) — a border
    // colour for a background. Segment overlap has to win over raw distance.
    expect(findings[0].suggestion).toBe('--yaar-bg-surface-hover');
  });

  test('a token the app declares itself is known', () => {
    const findings = scanTokens([
      file(':root{--yaar-card-bg:#111}', 'src/theme.css'),
      file('a{background:var(--yaar-card-bg)}', 'src/styles.css'),
    ]);
    expect(findings).toEqual([]);
  });

  test('cross-file: declaration in one file, usage in another', () => {
    // A per-file scan would call this undefined. It is not.
    const findings = scanTokens([
      file('a{background:var(--yaar-brand)}', 'src/styles.css'),
      file(':root{--yaar-brand:#f00}', 'src/tokens.css'),
    ]);
    expect(findings).toEqual([]);
  });

  test('reports file, line and column', () => {
    const findings = scanTokens([file('a{}\nb{color:var(--yaar-nope-nope-nope)}', 'src/x.css')]);
    expect(findings[0]).toMatchObject({ path: 'src/x.css', line: 2 });
    expect(findings[0].suggestion).toBeNull();
  });

  test('non-yaar custom properties are none of our business', () => {
    expect(scanTokens([file('a{color:var(--brand-blue)}')])).toEqual([]);
  });
});

describe('suggestToken', () => {
  test('stays silent when nothing is close', () => {
    expect(suggestToken('--yaar-completely-unrelated-thing', ['--yaar-sp-1'])).toBeNull();
  });
});
