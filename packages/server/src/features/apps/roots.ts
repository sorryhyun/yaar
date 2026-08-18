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
import { PREVIEW_APP_PREFIX } from '@yaar/shared';
import { PROJECT_ROOT, WORKSPACE_NAME } from '../../config.js';

/** Bundled apps shipped with the repo (git-tracked): system + optional first-party. */
export const APPS_DIR = join(PROJECT_ROOT, 'apps');

/**
 * User-installed apps from the marketplace (git-ignored). Keeps installs out of the
 * tracked tree. `YAAR_USER_APPS` overrides the location; an active workspace
 * (`YAAR_WORKSPACE`) pre-fills it, so installs land inside the workspace. Reading
 * `process.env` at module scope is safe here: `config.js` runs `env.ts`'s bootstrap
 * (`.env` load + workspace fill-in) before this constant evaluates.
 */
export const USER_APPS_DIR = process.env.YAAR_USER_APPS || join(PROJECT_ROOT, 'user-apps');

/** Roots scanned for apps, in precedence order (bundled wins on id collision). */
export const APP_ROOTS = [APPS_DIR, USER_APPS_DIR] as const;

/** Root that marketplace installs are written to. */
export const INSTALL_ROOT = USER_APPS_DIR;

/**
 * Root a *newly deployed* app is written to. Normally the bundled `apps/` tree
 * (devtools-built apps ship first-party), but under a workspace new deploys go to the
 * workspace's user-apps root instead — an experiment must not dirty the tracked tree,
 * which is the whole point of running one. Existing apps still update in place
 * wherever `resolveAppDir()` finds them.
 */
export const DEPLOY_ROOT = WORKSPACE_NAME ? USER_APPS_DIR : APPS_DIR;

export type AppSource = 'bundled' | 'user';

// ── App id policy ───────────────────────────────────────────────────────────

/**
 * Kebab-case: starts with a lowercase letter, then lowercase letters, digits, or hyphens.
 *
 * Matches the marketplace's own id rule, so a publish refused there is refused here first
 * with a better message. It is also the shape the id has to keep to be safe as a path
 * segment under {@link APP_ROOTS} — no dots, no slashes, so no traversal.
 */
const APP_ID_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Ids that are well-formed but that no app may *claim*.
 *
 * `self` is the pronoun `resolveSelf` (`http/uri-match.ts`) expands to the calling app's
 * own id. An app owning the literal id would be permanently unaddressable by anyone else:
 * every `yaar://apps/self/…` another app wrote would expand to *that* app's namespace
 * before the match ever saw a literal `self`. Note this shadows rather than widens —
 * expansion always rewrites toward the caller, so there is no cross-app reach hiding in
 * it — but "installed and unreachable by construction" is not a state worth supporting,
 * and the failure would be silent at every door.
 *
 * The check lives here rather than in the URI layer on purpose. Rejecting `self` where
 * URIs are *parsed* would half-break an app that had already been installed under the
 * name; rejecting it where an id is *claimed* means one never exists.
 */
const RESERVED_APP_IDS = new Set(['self']);

/**
 * Prefixes no app may claim.
 *
 * `preview--` is {@link PREVIEW_APP_PREFIX}, the identity a devtools preview runs under.
 * Its declaration reasons that the double hyphen keeps a preview from colliding with a
 * deployed id "which is slug-like and would not normally contain one" — this is the check
 * that turns that *normally* into a rule. A deployed app holding one would share both a
 * storage namespace and an app-protocol active-window slot with any preview of the
 * matching project, which is exactly the blast radius that prefix exists to prevent.
 *
 * Previews never create a directory under {@link APP_ROOTS} — they are principals, not
 * installs — so reserving the prefix costs them nothing.
 */
const RESERVED_APP_ID_PREFIXES = [PREVIEW_APP_PREFIX];

/**
 * Why this id may not be claimed, or `null` if it may.
 *
 * The one definition of app-id policy: shape *and* reservations, so a caller cannot
 * satisfy the regex and skip the reserved list. Returns the reason rather than a boolean
 * because every caller reports it to a human — an id refused with no cause reads as a
 * bug in the tool.
 */
export function appIdRefusal(appId: string): string | null {
  if (!APP_ID_RE.test(appId)) {
    return `Invalid app id "${appId}". Use lowercase letters, digits and hyphens, starting with a letter.`;
  }
  if (RESERVED_APP_IDS.has(appId)) {
    return `"${appId}" is a reserved app id and cannot be used.`;
  }
  const prefix = RESERVED_APP_ID_PREFIXES.find((p) => appId.startsWith(p));
  if (prefix) {
    return `App ids cannot start with "${prefix}" — it is reserved.`;
  }
  return null;
}

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
