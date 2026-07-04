/**
 * App roots — where apps live on disk.
 *
 * Two roots, one logical namespace (app ids are unique across both):
 *  - `apps/`      — bundled apps shipped with the repo (git-tracked). Holds both
 *                   `kind: 'system'` core apps and optional first-party apps.
 *  - `user-apps/` — apps installed from the marketplace (git-ignored). Keeps
 *                   installs out of the tracked tree.
 *
 * Everything that needs an app's directory should go through `resolveAppDir()`
 * rather than hardcoding `join(PROJECT_ROOT, 'apps', id)`, so both roots resolve.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { PROJECT_ROOT } from '../../config.js';

/** Bundled apps shipped with the repo (git-tracked): system + optional first-party. */
export const APPS_DIR = join(PROJECT_ROOT, 'apps');

/** User-installed apps from the marketplace (git-ignored). */
export const USER_APPS_DIR = join(PROJECT_ROOT, 'user-apps');

/** Roots scanned for apps, in precedence order (bundled wins on id collision). */
export const APP_ROOTS = [APPS_DIR, USER_APPS_DIR] as const;

/** Root that marketplace installs are written to. */
export const INSTALL_ROOT = USER_APPS_DIR;

export type AppSource = 'bundled' | 'user';

/** Directory for an existing app, searching all roots (bundled first), or null. */
export function resolveAppDir(appId: string): string | null {
  for (const root of APP_ROOTS) {
    const dir = join(root, appId);
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** Whether an app is shipped (`bundled`) or installed (`user`); null if not found. */
export function resolveAppSource(appId: string): AppSource | null {
  if (existsSync(join(APPS_DIR, appId))) return 'bundled';
  if (existsSync(join(USER_APPS_DIR, appId))) return 'user';
  return null;
}
