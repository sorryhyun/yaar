import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The shell's twin of the compiler's design-token-guard: raw palette values in
 * CSS modules are drift. Colors come from tokens.css (generated) via var(--*),
 * or from color-mix() over a semantic token for alpha tints.
 *
 * Allowed exceptions:
 *  - #fff / #ffffff — text on accent/danger-colored fills (no on-accent token)
 *  - colors inside url(...) — data-URI SVG cannot resolve var()
 */
const STYLES_DIR = join(import.meta.dir, '../../styles');
const GENERATED = 'base/tokens.css';
const ALLOWED_HEX = new Set(['#fff', '#ffffff']);

/** Old-palette rgba channels that must never reappear (Catppuccin, Tailwind, glass). */
const BANNED_RGB = [
  '137, 180, 250', // catppuccin blue
  '59, 130, 246', // tailwind blue
  '34, 197, 94', // tailwind green
  '239, 68, 68', // tailwind red
  '234, 179, 8', // tailwind amber
  '166, 227, 161', // catppuccin green
  '243, 139, 168', // catppuccin red
  '249, 226, 175', // catppuccin yellow
  '30, 30, 46', // catppuccin base (glass)
  '24, 24, 37', // catppuccin mantle (glass)
];

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...cssFiles(full));
    else if (entry.endsWith('.css')) out.push(full);
  }
  return out;
}

describe('shell style guard', () => {
  const files = cssFiles(STYLES_DIR).filter((f) => !f.replace(/\\/g, '/').endsWith(GENERATED));

  test('found the style modules', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test('no raw hex colors outside tokens.css', () => {
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8').replace(/url\([^)]*\)/g, 'url()');
      src.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
          if (!ALLOWED_HEX.has(m[0].toLowerCase())) {
            violations.push(`${file}:${i + 1} ${m[0]}`);
          }
        }
      });
    }
    expect(violations).toEqual([]);
  });

  test('no legacy-palette rgba values', () => {
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        const normalized = line.replace(
          /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g,
          'rgb($1, $2, $3',
        );
        for (const rgb of BANNED_RGB) {
          if (normalized.includes(`rgb(${rgb}`)) violations.push(`${file}:${i + 1} rgba(${rgb},…)`);
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
