/**
 * Guards the blast-radius assumption behind ISOLATED_APP_SANDBOX
 * (docs/guides/remote_mode.md): no bundled app navigates the top window.
 *
 * The sandbox on isolated app frames withholds the top-navigation family. That is
 * safe *because nothing uses it* — the top window is the desktop, and swapping it
 * out is the phishing vector, not a feature. This test fails the moment an app's
 * source starts navigating the top, so the decision to withhold the token can never
 * silently start breaking a real app.
 */
import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// packages/frontend/src/tests/components → repo root
const APPS_DIR = join(import.meta.dir, '../../../../../apps');

// `top`/`parent` are the desktop from an app's frame; assigning their location, or
// targeting a link/form at `_top`/`_parent`, navigates the whole desktop away.
const TOP_NAV = /\b(?:window\.)?(?:top|parent)\.location\b|target\s*=\s*["']_(?:top|parent)["']/;

function appSourceFiles(): string[] {
  const out: string[] = [];
  for (const app of readdirSync(APPS_DIR, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const src = join(APPS_DIR, app.name, 'src');
    let entries: string[];
    try {
      entries = readdirSync(src, { recursive: true }) as string[];
    } catch {
      continue; // no src/ dir
    }
    for (const rel of entries) {
      if (/\.(?:ts|tsx|js|jsx|html)$/.test(rel)) out.push(join(src, rel));
    }
  }
  return out;
}

describe('bundled apps do not navigate the top window', () => {
  it('no app source assigns top/parent.location or targets _top/_parent', () => {
    const offenders = appSourceFiles().filter((f) => TOP_NAV.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
