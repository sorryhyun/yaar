/**
 * Where a benchmark finds a Chrome to drive. `CHROME_PATH` wins; otherwise the usual
 * macOS and Linux install locations. The server has its own discovery
 * (`packages/server/src/lib/browser/chrome.ts`); a benchmark harness stays independent of it.
 */
import { existsSync } from 'node:fs';

export function findChrome(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? null;
}
