/**
 * YAAR Design Tokens — shared CSS custom properties and utility classes.
 *
 * Injected into every compiled app iframe at compile time (zero imports needed).
 * Apps can override any token via their own `:root` block.
 * All custom properties are prefixed `--yaar-*`, all classes prefixed `y-`.
 *
 * The CSS itself is GENERATED from the canonical token data in
 * `@yaar/shared` (`packages/shared/src/design/`) — the same data that
 * generates the OS shell's `tokens.css`, so the two layers cannot drift.
 */
import { YAAR_APP_TOKENS_CSS } from '@yaar/shared';

export const YAAR_DESIGN_TOKENS_CSS = YAAR_APP_TOKENS_CSS;

/**
 * The classes an app is expected to reach for, kept short on purpose.
 *
 * Curated from real usage across the app fleet, not derived — which class is
 * *common* is not a fact the CSS knows. It is filtered against the parsed class
 * set before it is printed, so a renamed class disappears from the starter list
 * instead of being advertised into a silent no-op, and a test asserts nothing
 * was dropped so the rename is loud in CI rather than quiet in a prompt.
 */
const STARTER_CLASSES = [
  'y-app',
  'y-btn',
  'y-btn-primary',
  'y-btn-ghost',
  'y-btn-danger',
  'y-btn-sm',
  'y-input',
  'y-select',
  'y-label',
  'y-list-item',
  'y-empty',
  'y-empty-icon',
  'y-scroll',
  'y-truncate',
  'y-dot',
];

/**
 * Classes the SDK writes into the DOM itself.
 *
 * Listing them as authoring choices is worse than not listing them: an app that
 * hand-writes `.y-toast` markup gets the styling without the lifecycle
 * `showToast()` owns. Same discipline as `STARTER_CLASSES` — filtered against
 * the parsed set, asserted by test.
 */
const SDK_EMITTED_CLASSES = [
  'y-toast',
  'y-toast-info',
  'y-toast-success',
  'y-toast-error',
  'y-toast-visible',
  'y-modal',
  'y-modal-title',
  'y-modal-msg',
  'y-modal-actions',
  'y-overlay',
];

/** A bare length (`4px`, `1.5rem`) — the one kind of value worth quoting inline. */
const LENGTH_RE = /^-?\d+(\.\d+)?(px|rem|em|%)$/;

/** `--yaar-bg-surface-hover` → `bg`. The family is the first segment after the prefix. */
function familyOf(name: string): string {
  return name.replace(/^(--yaar-|y-)/, '').split('-')[0];
}

/** Group names by `familyOf`, preserving the order each family was first seen in. */
function byFamily(names: string[]): Map<string, string[]> {
  const families = new Map<string, string[]>();
  for (const name of names) {
    const family = familyOf(name);
    const members = families.get(family);
    if (members) members.push(name);
    else families.set(family, [name]);
  }
  return families;
}

/** Every `--yaar-*` the injected CSS declares, in declaration order, with values. */
function parseTokens(): { name: string; value: string }[] {
  // Only the `:root` block declares tokens; `var(--x)` references must not match.
  const rootBlock = YAAR_DESIGN_TOKENS_CSS.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  return [...rootBlock.matchAll(/(--yaar-[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map((m) => ({
    name: m[1],
    value: m[2].trim(),
  }));
}

/** Every `y-*` class the injected CSS defines, sorted. */
function parseClasses(): string[] {
  // Not anchored to line start: the CSS packs several rules onto one line
  // (`.y-flex{...}.y-flex-col{...}`), and an anchored match would silently omit
  // every class but the first — telling an agent that `.y-flex-col` is not real.
  return [
    ...new Set([...YAAR_DESIGN_TOKENS_CSS.matchAll(/\.(y-[a-z0-9-]+)\s*[{,.:]/g)].map((m) => m[1])),
  ].sort();
}

/** A curated list, narrowed to what the CSS actually still defines. */
function realOnly(curated: string[], defined: Set<string>): string[] {
  return curated.filter((c) => defined.has(c));
}

/**
 * The short form: every token NAME, no values, plus the starter classes.
 *
 * This is what the App Authoring Contract embeds, so it is paid for on every
 * session of every app that can build apps — whether or not that session writes
 * a line of CSS. What it drops relative to the full reference is *values* and
 * the 122-class enumeration; what it deliberately keeps is every token name,
 * because the two failure modes are not symmetric:
 *
 *   - a `--yaar-*` name that does not exist is caught by the compiler's token
 *     guard, with the nearest real name suggested;
 *   - a `y-*` class that does not exist fails silently — no rule, no error,
 *     unstyled markup.
 *
 * So a *summarized* token list (families as ranges) would reintroduce exactly
 * the guessing the guard exists to stop — `--yaar-space-2` is how devtools got
 * here — while a summarized class list only costs a lookup. The names are the
 * cheap half anyway: values are ~55% of the full reference's bytes, and an app
 * must not copy a colour value regardless.
 */
export function describeDesignTokensBrief(): string {
  const tokens = parseTokens();
  const classes = parseClasses();
  const defined = new Set(classes);
  const starters = realOnly(STARTER_CLASSES, defined);

  const lines: string[] = [
    '# YAAR Design Tokens (essentials)',
    '',
    'Injected into every compiled app. No import needed. Always reach for a token —',
    'var(--yaar-accent), never #539bf5. A name not listed below resolves to nothing',
    'and drops the whole declaration; the compiler rejects it at build time and names',
    'the closest real token, so a build error about one is telling you the truth.',
    'To use a name of your own, declare it in your own :root block or supply a',
    'fallback: var(--yaar-custom, #fff).',
    '',
    `## Every --yaar-* name that exists (${tokens.length})`,
    '',
  ];

  const values = new Map(tokens.map((t) => [t.name, t.value]));
  for (const [family, names] of byFamily(tokens.map((t) => t.name))) {
    const rendered = names.map((name) => {
      // A length is the one value worth inlining: picking a spacing step needs
      // the number. A colour does not — the app is told to use the name.
      const value = values.get(name) ?? '';
      return LENGTH_RE.test(value) ? `${name}(${value})` : name;
    });
    lines.push(`${family}: ${rendered.join(' ')}`);
  }

  lines.push(
    '',
    `## Starter classes (${starters.length} of ${classes.length})`,
    '',
    starters.map((c) => `.${c}`).join(' '),
    '',
    'Unlike a token, a y- class that does not exist fails SILENTLY: no rule, no',
    'error, unstyled markup. So before using any class not listed above, look it up.',
    `describeBundledLibrary({ name: 'design-tokens' }) returns all ${classes.length} classes`,
    'grouped by family, every token value, and the classes the SDK emits for you.',
  );

  return lines.join('\n');
}

/**
 * The full reference: every token with its value, every class, grouped by family.
 *
 * This is what an agent gets back from `describeBundledLibrary({ name:
 * 'design-tokens' })` — on demand, for the session that is actually writing CSS.
 * Generated from `YAAR_DESIGN_TOKENS_CSS` rather than written by hand, so it can
 * never disagree with what the compiler actually injects.
 */
export function describeDesignTokens(): string {
  const tokens = parseTokens();
  const classes = parseClasses();
  const defined = new Set(classes);
  const emitted = new Set(realOnly(SDK_EMITTED_CLASSES, defined));

  const lines: string[] = [
    '# YAAR Design Tokens',
    '',
    'Injected into every compiled app. No import needed.',
    '',
    `## Custom properties (${tokens.length})`,
    '',
    'These are the ONLY --yaar-* names that exist. Using any other name silently',
    'drops the whole declaration at render time, and the compiler will reject it.',
    '',
    ':root {',
    ...tokens.map((t) => `  ${t.name}: ${t.value}`),
    '}',
    '',
    'To read one from JS or canvas, ask the document rather than pasting the hex:',
    "getComputedStyle(document.documentElement).getPropertyValue('--yaar-accent').trim()",
    '— a pasted value stops tracking .y-light and any accent override.',
    '',
    `## Utility classes (${classes.length})`,
    '',
  ];

  // Grouped by family rather than one alphabetical blob: a class list is read to
  // answer "what is there for X", and the blob answers only "is this one real".
  for (const [family, names] of byFamily(classes)) {
    lines.push(`${family}: ${names.map((c) => `.${c}`).join(' ')}`);
  }

  if (emitted.size > 0) {
    lines.push(
      '',
      '## Emitted by the SDK — do not hand-write',
      '',
      [...emitted].map((c) => `.${c}`).join(' '),
      '',
      'showToast() and showConfirm()/showPrompt() write this markup themselves.',
      'Hand-writing it gets the styling without the lifecycle they own.',
    );
  }

  lines.push(
    '',
    '## Rules',
    '',
    '- Always use var(--yaar-*) for colors, spacing and fonts. Never hardcode.',
    '- To use a name not listed above, either declare it yourself in your own',
    '  :root block, or supply a fallback: var(--yaar-custom, #fff).',
  );

  return lines.join('\n');
}
