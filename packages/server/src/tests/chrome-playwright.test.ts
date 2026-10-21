/**
 * `findChrome` looks in a Playwright install's browser cache (issue #187, item 3).
 *
 * Cloud sandboxes and CI images ship Chromium only that way — `PLAYWRIGHT_BROWSERS_PATH`
 * set, no system Chrome, nothing on PATH — and every browser feature used to be dead
 * there until someone set CHROME_PATH by hand.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { playwrightChromeCandidates } from '../lib/browser/chrome.js';

describe('playwrightChromeCandidates', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'yaar-pw-'));
    for (const build of [
      'chromium-1100',
      'chromium-1194',
      'chromium_headless_shell-1194',
      'ffmpeg-1011',
    ]) {
      await mkdir(join(root, build), { recursive: true });
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Only what this test put there — the machine's own caches are not the subject. */
  function candidates(): string[] {
    const missing = join(root, 'nowhere');
    return playwrightChromeCandidates({
      PLAYWRIGHT_BROWSERS_PATH: root,
      XDG_CACHE_HOME: missing,
      LOCALAPPDATA: missing,
    }).filter((p) => p.startsWith(root));
  }

  it('offers full Chromium builds under PLAYWRIGHT_BROWSERS_PATH, newest first', () => {
    const builds = [
      ...new Set(candidates().map((p) => p.slice(root.length + 1).split(/[/\\]/)[0])),
    ];
    expect(builds).toEqual(['chromium-1194', 'chromium-1100']);
  });

  it('skips the headless shell, which cannot show a live tab', () => {
    expect(candidates().some((p) => p.includes('headless_shell'))).toBe(false);
  });
});
