/**
 * The Environment section's app blocks.
 *
 * These two blocks are the largest thing in a monitor agent's system prompt, and
 * they used to state every hinted app twice — once as a roster line with its
 * description, once as a hint section. Merging them means each app appears exactly
 * once, which buys back real prompt bytes but introduces the failure this file
 * exists to hold shut: **neither block is complete on its own**. An agent that
 * reads a partial roster as exhaustive concludes an installed app is not installed
 * and builds the UI by hand — the silent regression, with no error anywhere.
 *
 * `buildAppSections` is pure so these cases need no filesystem. That matters
 * beyond convenience: `listApps()` reads `user-apps/`, which is git-ignored, so a
 * test asserting on real output would pass here and mean something different in CI.
 */

import { describe, it, expect } from 'bun:test';
import { buildAppSections } from '../providers/environment.js';
import type { AppInfo } from '../features/apps/discovery.js';

function app(id: string, over: Partial<AppInfo> = {}): AppInfo {
  return {
    id,
    name: id.toUpperCase(),
    kind: 'app',
    source: 'bundled',
    description: `${id} description`,
    hasConfig: false,
    ...over,
  };
}

describe('buildAppSections', () => {
  it('states a hinted app once — under its hint, not in the roster', () => {
    const text = buildAppSections(
      [app('notes'), app('memo')],
      [{ appId: 'notes', hint: 'Use for long-form writing.' }],
    ).join('\n');

    // Present exactly once, and it is the hint that carries it.
    expect(text.match(/\bnotes\b/g)?.length).toBe(1);
    expect(text).toContain('### NOTES (notes)');
    expect(text).toContain('Use for long-form writing.');
    // The roster line, with its description, is the part that got dropped.
    expect(text).not.toContain('notes description');
    // The unhinted app keeps its full description — its only selection signal.
    expect(text).toContain('- **MEMO** (memo): memo description');
  });

  it('tells the agent neither list is the whole set', () => {
    const text = buildAppSections([app('a'), app('b')], [{ appId: 'b', hint: 'h' }]).join('\n');

    expect(text).toContain('the apps under "App hints" below are installed too');
    expect(text).toContain('App hints — these apps are installed too');
  });

  it('omits the cross-reference when there is nothing to cross-reference', () => {
    const text = buildAppSections([app('a')], []).join('\n');

    expect(text).toContain('- Installed apps:');
    expect(text).not.toContain('App hints');
  });

  it('carries iframe openability, which list(yaar://apps) does not report', () => {
    // `kind` is criticality, not compiled-ness, so `isCompiled` is reachable
    // nowhere else without reading each app one at a time.
    const text = buildAppSections(
      [app('draws', { isCompiled: true }), app('plain')],
      [{ appId: 'shelf', hint: 'h' }],
    ).join('\n');

    expect(text).toContain('(iframe: yaar://apps/draws)');
    expect(text).not.toContain('(iframe: yaar://apps/plain)');
  });

  it('keeps a hint whose app.json no longer resolves', () => {
    // Hints are found by scanning app dirs, so a hint can outlive its manifest.
    // Dropping it silently is the failure mode; the bare id is the fallback.
    const text = buildAppSections([], [{ appId: 'ghost', hint: 'still useful' }]).join('\n');

    expect(text).toContain('### ghost');
    expect(text).toContain('still useful');
  });

  it('renders variant and system flags on both sides of the merge', () => {
    const text = buildAppSections(
      [
        app('dock', { variant: 'panel', dockEdge: 'bottom', createShortcut: false }),
        app('hinted', { variant: 'panel', dockEdge: 'top' }),
      ],
      [{ appId: 'hinted', hint: 'h' }],
    ).join('\n');

    expect(text).toContain('[panel:bottom] [system]');
    expect(text).toContain('### HINTED (hinted) [panel:top]');
  });

  it('orders both blocks by id regardless of input order', () => {
    const text = buildAppSections(
      [app('zeta'), app('alpha'), app('zulu'), app('bravo')],
      [
        { appId: 'zulu', hint: 'z' },
        { appId: 'bravo', hint: 'b' },
      ],
    ).join('\n');

    expect(text.indexOf('(alpha)')).toBeLessThan(text.indexOf('(zeta)'));
    expect(text.indexOf('### BRAVO (bravo)')).toBeLessThan(text.indexOf('### ZULU (zulu)'));
  });

  it('produces nothing at all when no apps are installed', () => {
    expect(buildAppSections([], [])).toEqual([]);
  });
});
