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
 * A human-readable reference for the tokens and utility classes above.
 *
 * Generated from `YAAR_DESIGN_TOKENS_CSS` rather than written by hand, so it can
 * never disagree with what the compiler actually injects. This is what an agent
 * gets back from `describeBundledLibrary({ name: 'design-tokens' })`, and what
 * the app-agent prompt embeds — the token names an app may use are a fact the
 * compiler owns, and it should be the one stating them.
 */
export function describeDesignTokens(): string {
  const vars: string[] = [];
  // Only the `:root` block declares tokens; `var(--x)` references must not match.
  const rootBlock = YAAR_DESIGN_TOKENS_CSS.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  for (const m of rootBlock.matchAll(/(--yaar-[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    vars.push(`  ${m[1]}: ${m[2].trim()}`);
  }

  // Not anchored to line start: the CSS packs several rules onto one line
  // (`.y-flex{...}.y-flex-col{...}`), and an anchored match would silently omit
  // every class but the first — telling an agent that `.y-flex-col` is not real.
  const classes = [
    ...new Set([...YAAR_DESIGN_TOKENS_CSS.matchAll(/\.(y-[a-z0-9-]+)\s*[{,.:]/g)].map((m) => m[1])),
  ].sort();

  return [
    '# YAAR Design Tokens',
    '',
    'Injected into every compiled app. No import needed.',
    '',
    `## Custom properties (${vars.length})`,
    '',
    'These are the ONLY --yaar-* names that exist. Using any other name silently',
    'drops the whole declaration at render time, and the compiler will reject it.',
    '',
    ':root {',
    ...vars,
    '}',
    '',
    `## Utility classes (${classes.length})`,
    '',
    classes.map((c) => `.${c}`).join(' '),
    '',
    '## Rules',
    '',
    '- Always use var(--yaar-*) for colors, spacing and fonts. Never hardcode.',
    '- To use a name not listed above, either declare it yourself in your own',
    '  :root block, or supply a fallback: var(--yaar-custom, #fff).',
  ].join('\n');
}
