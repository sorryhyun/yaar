import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Bun's CSS-modules pass scopes `@keyframes` *names* — both the definition and every
 * reference to it — so an animation named in a `.module.css` but defined in a global
 * stylesheet compiles to a reference that matches nothing. The animation then silently
 * does not run: no build error, no console warning. That is how the whole shell lost its
 * spinners and how the LoadingScreen's fade-out stopped firing, leaving "Loading…" pinned
 * over a fully connected desktop.
 *
 * Two rules keep it from happening again:
 *  1. a module defines every animation it names;
 *  2. no `animation`/`animation-name` value carries a var() — a shorthand holding one is
 *     unparseable to the scoping pass, which then leaves the name alone (the inverse
 *     failure: a reference that survives while its keyframes get scoped away). Durations
 *     go in `animation-duration: var(--duration-*)` instead.
 */
const STYLES_DIR = join(import.meta.dir, '../../styles');

/** Everything an `animation` shorthand can hold that is not the keyframes name. */
const NON_NAME = new Set([
  'normal',
  'reverse',
  'alternate',
  'alternate-reverse',
  'none',
  'forwards',
  'backwards',
  'both',
  'running',
  'paused',
  'infinite',
  'linear',
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'step-start',
  'step-end',
  'initial',
  'inherit',
  'unset',
  'revert',
]);

function moduleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...moduleFiles(full));
    else if (entry.endsWith('.module.css')) out.push(full);
  }
  return out;
}

/** Declaration values for `animation` / `animation-name`, comments stripped. */
function animationValues(src: string): { prop: string; value: string }[] {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/\b(animation|animation-name)\s*:\s*([^;{}]+);/g)].map((m) => ({
    prop: m[1]!,
    value: m[2]!.replace(/\s+/g, ' ').trim(),
  }));
}

function referencedNames(value: string, prop: string): string[] {
  return value
    .split(',')
    .flatMap((part) => {
      const tokens = part.trim().split(/\s+/);
      if (prop === 'animation-name') return tokens.slice(0, 1);
      // Shorthand: the name is the one bare identifier that isn't a keyword or a value.
      return tokens.filter(
        (t) => /^[A-Za-z_][\w-]*$/.test(t) && !NON_NAME.has(t) && !/^(steps|cubic-bezier)$/.test(t),
      );
    })
    .filter(Boolean);
}

describe('CSS module animation scoping', () => {
  const files = moduleFiles(STYLES_DIR);

  test('found the style modules', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test('every animation a module names is defined in that module', () => {
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const defined = new Set([...src.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]!));
      for (const { prop, value } of animationValues(src)) {
        for (const name of referencedNames(value, prop)) {
          if (!defined.has(name)) {
            violations.push(`${relative(STYLES_DIR, file)}: "${name}" has no @keyframes here`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('no animation name arrives through a var()', () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const { prop, value } of animationValues(readFileSync(file, 'utf8'))) {
        if (value.includes('var(')) {
          violations.push(`${relative(STYLES_DIR, file)}: ${prop}: ${value}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
