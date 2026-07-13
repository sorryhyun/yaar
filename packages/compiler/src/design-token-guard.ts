/**
 * Static guard for `--yaar-*` design token usage.
 *
 * CSS custom properties are untyped by construction: `var(--yaar-space-2)` is
 * valid CSS whether or not `--yaar-space-2` exists. When it doesn't, the
 * declaration is dropped at computed-value time and the element silently renders
 * with no padding / no background — a green build and a broken app. Typecheck
 * cannot see this: the token name lives in a string, or in a `.css` file.
 *
 * The compiler *owns* the token set (it injects `YAAR_DESIGN_TOKENS_CSS` into
 * every app), so it can check each usage against the definitions it emits. The
 * known set is parsed from that CSS rather than hardcoded, so the guard cannot
 * drift from the tokens actually shipped.
 *
 * Two usages are deliberately NOT errors:
 *   - `var(--yaar-x, fallback)` — an explicit fallback makes an undefined token
 *     harmless by design; that is what the fallback is for.
 *   - tokens the app defines itself (`--yaar-card-bg: ...` in its own `:root`),
 *     which is the documented way to extend the palette.
 */

import { YAAR_DESIGN_TOKENS_CSS } from './design-tokens.js';

/** Matches a custom-property *declaration*: `--yaar-foo:` */
const DECL_RE = /(--yaar-[a-z0-9-]+)\s*:/gi;

/**
 * Matches a `var()` *reference*, capturing the token and the delimiter that
 * follows it. A `,` means a fallback was supplied; a `)` means it was not.
 */
const USAGE_RE = /var\(\s*(--yaar-[a-z0-9-]+)\s*([,)])/gi;

/** Collect every `--yaar-*` declared in a CSS string. */
function collectDeclarations(css: string, into: Set<string>): void {
  for (const m of css.matchAll(DECL_RE)) into.add(m[1].toLowerCase());
}

/** The tokens the compiler injects into every app. Derived, never hardcoded. */
export function knownTokens(): Set<string> {
  const tokens = new Set<string>();
  collectDeclarations(YAAR_DESIGN_TOKENS_CSS, tokens);
  return tokens;
}

/** Levenshtein distance, used only to suggest a near-miss. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

/** The meaningful parts of a token name: `--yaar-bg-surface-hover` → {bg, surface, hover}. */
function segments(token: string): Set<string> {
  return new Set(
    token
      .replace(/^--yaar-/, '')
      .split('-')
      .filter(Boolean),
  );
}

/**
 * The closest known token, when one is close enough to be worth naming.
 *
 * Ranks by *segment overlap* first and edit distance only as a tie-break, because
 * raw edit distance systematically picks the wrong token here. The real miss
 * `--yaar-bg-hover` is 5 edits from `--yaar-border` but 8 from the token actually
 * meant, `--yaar-bg-surface-hover` — so a pure-Levenshtein guard confidently
 * suggests a border colour for a background. Segment overlap sees that the
 * long name contains *both* words the author wrote and the short one contains
 * neither.
 */
export function suggestToken(unknown: string, known: Iterable<string>): string | null {
  const wanted = segments(unknown);
  let best: string | null = null;
  let bestOverlap = -1;
  let bestDist = Infinity;

  for (const candidate of known) {
    const have = segments(candidate);
    let shared = 0;
    for (const s of wanted) if (have.has(s)) shared++;
    const overlap = wanted.size === 0 ? 0 : shared / wanted.size;
    const d = distance(unknown, candidate);

    if (overlap > bestOverlap || (overlap === bestOverlap && d < bestDist)) {
      bestOverlap = overlap;
      bestDist = d;
      best = candidate;
    }
  }

  if (best === null) return null;
  // Name a candidate only when it shares at least half the author's words, or is
  // a plain typo away. Otherwise say nothing rather than misdirect.
  const budget = Math.max(3, Math.floor(unknown.length / 3));
  return bestOverlap >= 0.5 || bestDist <= budget ? best : null;
}

export interface AppSourceFile {
  /** Path as it should appear in the error message. */
  path: string;
  text: string;
}

export interface TokenFinding {
  path: string;
  line: number;
  column: number;
  token: string;
  suggestion: string | null;
}

/** 1-indexed line/column of `index` within `text`. */
function positionOf(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const column = index - (before.lastIndexOf('\n') + 1) + 1;
  return { line, column };
}

/**
 * Scan an app's sources for `var(--yaar-*)` references that can never resolve.
 *
 * Takes the whole file set rather than one file at a time: an app may declare a
 * token in `theme.css` and use it in `main.ts`, and a per-file scan would call
 * that a defect.
 */
export function scanTokens(files: AppSourceFile[]): TokenFinding[] {
  const defined = knownTokens();
  // App-defined tokens count as known, wherever in the app they are declared.
  for (const file of files) collectDeclarations(file.text, defined);

  const findings: TokenFinding[] = [];
  for (const file of files) {
    for (const m of file.text.matchAll(USAGE_RE)) {
      const token = m[1].toLowerCase();
      const hasFallback = m[2] === ',';
      if (hasFallback || defined.has(token)) continue;

      const { line, column } = positionOf(file.text, m.index);
      findings.push({
        path: file.path,
        line,
        column,
        token,
        suggestion: suggestToken(token, defined),
      });
    }
  }
  return findings;
}

/** Render findings as a compile error body. */
export function formatTokenFindings(findings: TokenFinding[]): string {
  const lines = findings.map((f) => {
    const fix = f.suggestion
      ? `did you mean ${f.suggestion}?`
      : `no such token — see the YAAR design tokens, or give it a fallback: var(${f.token}, <value>)`;
    return `${f.path}:${f.line}:${f.column}: var(${f.token})\n  ${fix}`;
  });
  const n = findings.length;
  return (
    `design tokens: ${n} undefined token${n === 1 ? '' : 's'}\n\n` +
    `${lines.join('\n\n')}\n\n` +
    `An undefined custom property makes the whole declaration drop at render time — ` +
    `the app compiles, then shows no spacing/background where you expected it.`
  );
}
