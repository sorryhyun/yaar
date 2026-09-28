/**
 * Static check for `y-*` utility class usage — the class-side sibling of the
 * `--yaar-*` token guard (`design-token-guard.ts`).
 *
 * A class that does not exist is worse than a token that does not exist: there is
 * no declaration to drop, so nothing is even computed wrong — the markup just
 * renders unstyled. The compiler injects the class set (`YAAR_DESIGN_TOKENS_CSS`),
 * so it can say exactly which names are real.
 *
 * Unlike the token guard this one WARNS rather than fails the build, because it
 * reads class names out of strings: which string is a class list is a heuristic,
 * and a heuristic may not refuse a build. It keeps its false positives near zero
 * by only looking where a class list unambiguously is —
 *
 *   - `class="..."` / `className="..."` attribute values (html templates, JSX),
 *   - `className = '...'` assignments and `class:` / `className:` properties,
 *   - string arguments of `classList.add/remove/toggle/contains/replace(...)`,
 *
 * and by skipping every name it cannot read whole: `y-btn-${variant}` and
 * `'y-tone-' + tone` are dynamic, so they are never reported. A class the app
 * defines in its own CSS (`.y-card-grid { ... }`) is known, the same way an
 * app-declared `--yaar-*` token is.
 *
 * `y-axis` in a chart label is not a class list, which is why "any `y-` word in
 * any string" is not the rule.
 */

import { YAAR_DESIGN_TOKENS_CSS } from '../design-tokens.js';
import { suggestToken, type AppSourceFile } from './design-token-guard.js';

/** A class selector in CSS: `.y-foo` followed by what can follow a selector part. */
const CSS_CLASS_RE = /\.(-?[a-z_][a-z0-9_-]*)(?=\s*[{,.:>+~[)\s])/gi;

/** `class="..."` (html templates, JSX) and `el.className = '...'` — a quoted value after `=`. */
const ATTR_RE = /\bclass(?:Name)?\s*=\s*(["'`])([\s\S]*?)\1/g;

/** `{ class: '...' }`, `{ className: `...` }` — a quoted value after `:`. */
const PROP_RE = /\bclass(?:Name)?\s*:\s*(["'`])([\s\S]*?)\1/g;

/** `classList.add('a', 'b')` — the argument list, up to the closing paren. */
const CLASSLIST_RE = /\bclassList\s*\.\s*(?:add|remove|toggle|contains|replace)\s*\(([^)]*)\)/g;

/** A quoted string inside a captured region (an argument list, a `${}` expression). */
const QUOTED_RE = /(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g;

/** A complete, static `y-*` class name. Rejects `y-foo-` (a stem) by requiring a final [a-z0-9]. */
const Y_CLASS_RE = /^y-[a-z0-9-]*[a-z0-9]$/;

/** Every class the given CSS defines. */
function collectCssClasses(css: string, into: Set<string>): void {
  // Strip comments first: `/* .y-old was renamed */` defines nothing.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of stripped.matchAll(CSS_CLASS_RE)) into.add(m[1].toLowerCase());
}

/** The `y-*` classes the compiler injects into every app. Derived, never hardcoded. */
export function knownClasses(): Set<string> {
  const all = new Set<string>();
  collectCssClasses(YAAR_DESIGN_TOKENS_CSS, all);
  return new Set([...all].filter((c) => c.startsWith('y-')));
}

/**
 * The whole words of a class-list string that are static `y-*` names.
 *
 * A word touching a `${` is part of an interpolated name and is skipped, and so is
 * the literal text of each `${...}` expression — but quoted strings *inside* an
 * expression (`${on ? 'y-active' : ''}`) are class names too, so they are read.
 */
function staticClassWords(value: string): { word: string; offset: number }[] {
  const out: { word: string; offset: number }[] = [];
  // Blank out each `${...}` (same length, so offsets survive), reading its quoted
  // strings first. One nesting level of braces is enough for real class lists.
  const exprRe = /\$\{((?:[^{}]|\{[^{}]*\})*)\}/g;
  const blanked = value.replace(exprRe, (whole, expr: string, at: number) => {
    const exprStart = at + 2;
    for (const q of expr.matchAll(QUOTED_RE)) {
      if (q[1] === '`' && q[2].includes('${')) continue; // nested template: dynamic
      for (const w of wordsOf(q[2])) {
        out.push({ word: w.word, offset: exprStart + q.index + 1 + w.offset });
      }
    }
    // A `$` marker keeps a name glued to the interpolation (`y-btn-${v}`) reading
    // as dynamic after the blanking.
    return '$' + ' '.repeat(whole.length - 1);
  });
  for (const w of wordsOf(blanked)) out.push(w);
  return out;
}

function wordsOf(text: string): { word: string; offset: number }[] {
  const out: { word: string; offset: number }[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const word = m[0];
    if (Y_CLASS_RE.test(word)) out.push({ word, offset: m.index });
  }
  return out;
}

/** 1-indexed line/column of `index` within `text`. */
function positionOf(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const column = index - (before.lastIndexOf('\n') + 1) + 1;
  return { line, column };
}

export interface ClassFinding {
  path: string;
  line: number;
  column: number;
  className: string;
  suggestion: string | null;
}

/** Every static `y-*` class reference in one TS source, with its offset in the file. */
function classReferences(text: string): { word: string; index: number }[] {
  const refs: { word: string; index: number }[] = [];
  const fromValue = (value: string, valueStart: number): void => {
    for (const w of staticClassWords(value))
      refs.push({ word: w.word, index: valueStart + w.offset });
  };

  for (const m of text.matchAll(ATTR_RE)) fromValue(m[2], m.index + m[0].length - m[2].length - 1);
  for (const m of text.matchAll(PROP_RE)) fromValue(m[2], m.index + m[0].length - m[2].length - 1);
  for (const m of text.matchAll(CLASSLIST_RE)) {
    const argsStart = m.index + m[0].indexOf('(') + 1;
    for (const q of m[1].matchAll(QUOTED_RE)) {
      if (q[1] === '`' && q[2].includes('${')) continue;
      fromValue(q[2], argsStart + q.index + 1);
    }
  }

  // A `classList.add(...)` inside a `class="${...}"` value is matched twice;
  // report each position once.
  const seen = new Set<number>();
  return refs.filter((r) => !seen.has(r.index) && (seen.add(r.index), true));
}

/**
 * Scan an app's sources for `y-*` classes that no stylesheet defines.
 *
 * Whole file set, like `scanTokens`: an app may define `.y-card-grid` in
 * `styles.css` and use it in `main.ts`.
 */
export function scanClasses(files: AppSourceFile[]): ClassFinding[] {
  const defined = knownClasses();
  for (const file of files) {
    if (file.path.endsWith('.css')) collectCssClasses(file.text, defined);
  }
  // A `<style>` block or `css` template inside TS defines classes too.
  for (const file of files) {
    if (!file.path.endsWith('.css')) {
      for (const m of file.text.matchAll(/\.(y-[a-z0-9-]*[a-z0-9])\s*\{/g)) defined.add(m[1]);
    }
  }

  const findings: ClassFinding[] = [];
  for (const file of files) {
    if (file.path.endsWith('.css')) continue;
    for (const ref of classReferences(file.text)) {
      const className = ref.word.toLowerCase();
      if (defined.has(className)) continue;
      const { line, column } = positionOf(file.text, ref.index);
      findings.push({
        path: file.path,
        line,
        column,
        className,
        suggestion: suggestToken(className, defined),
      });
    }
  }
  return findings;
}

/**
 * One warning line per finding. Plain ASCII, like every guard report
 * (`guard-report.ts` has the reason).
 */
export function formatClassFindings(findings: ClassFinding[]): string[] {
  return findings.map((f) => {
    const fix = f.suggestion
      ? `did you mean .${f.suggestion}?`
      : `no such class - see describeBundledLibrary({ name: 'design-tokens' }), or define it in the app's own CSS`;
    return (
      `${f.path}:${f.line}:${f.column}: unknown class .${f.className} - ${fix} ` +
      `(an undefined class renders unstyled, with no error)`
    );
  });
}
