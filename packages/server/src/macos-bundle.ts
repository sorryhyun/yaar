/**
 * The exe running as a macOS `.app` — what differs from a bare binary.
 *
 * A bare binary finds its bundled apps in `apps/` beside it, extracted there by
 * install.sh. A bundle keeps its data in `~/Library/Application Support/YAAR` instead
 * (`PROJECT_ROOT`, see `config/env.ts`), and it cannot keep writable apps inside itself —
 * writing into a signed bundle breaks the signature macOS ties its granted permissions to.
 * So the bundle ships them read-only in `Contents/Resources/apps`, and every launch of a
 * *different build* copies them over `PROJECT_ROOT/apps`, the same overwrite install.sh
 * does when it extracts a new release's apps archive. The stamp the build writes into the
 * bundled copy is what "a different build" means; an unchanged bundle copies nothing.
 *
 * Runs from `exe-bundle-entry.ts` before the server loads, because the server reads
 * `apps/` during boot.
 */

import { cpSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { MACOS_APP_BUNDLE, PROJECT_ROOT } from './config/env.js';
import { BUNDLED_APPS_STAMP } from './exe-assets.js';

function readStamp(dir: string): string | null {
  try {
    return readFileSync(join(dir, BUNDLED_APPS_STAMP), 'utf8');
  } catch {
    return null;
  }
}

export function seedBundledApps(): void {
  if (!MACOS_APP_BUNDLE) return;
  mkdirSync(PROJECT_ROOT, { recursive: true });

  const shipped = join(MACOS_APP_BUNDLE, 'Contents', 'Resources', 'apps');
  const installed = join(PROJECT_ROOT, 'apps');
  if (!existsSync(shipped)) return;
  const stamp = readStamp(shipped);
  if (stamp !== null && readStamp(installed) === stamp) return;

  // The stamp goes last, so a copy cut short is redone on the next launch instead of
  // being marked current.
  const stampPath = join(shipped, BUNDLED_APPS_STAMP);
  cpSync(shipped, installed, { recursive: true, force: true, filter: (src) => src !== stampPath });
  if (stamp !== null) cpSync(stampPath, join(installed, BUNDLED_APPS_STAMP));
}
