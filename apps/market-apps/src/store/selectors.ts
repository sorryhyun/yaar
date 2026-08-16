// The two derived lists the view renders from. Both are plain functions rather than
// memos: they are cheap, and Solid re-runs them only inside the thunks that read them.

import { normalizeId } from '../parsers/index.js';
import type { DisplayApp } from '../types.js';
import { hasInstalled, installedVersionOf, isOfficialAuthor } from './queries.js';
import { hideInstalled, installedApps, marketApps, search, searchMode } from './signals.js';

/**
 * The full card list: every marketplace app, plus apps installed locally that the
 * marketplace has never seen. The latter are what a developer publishes for the
 * first time — without them the UI could show sign-in but never a first Publish.
 *
 * Built-in system apps (dock, storage, the marketplace itself, …) are excluded:
 * they can't be uninstalled or published, so a marketplace card for them is dead
 * weight. They're kept out of the counts too by filtering at this single source.
 */
export function displayApps(): DisplayApp[] {
  const market = marketApps();
  const marketIds = new Set(market.map((m) => normalizeId(m.id)));
  const marketMapped: DisplayApp[] = market.map((m) => ({
    ...m,
    installed: m.installed || hasInstalled(m.id),
    installedVersion: installedVersionOf(m.id),
  }));
  const installedOnly: DisplayApp[] = installedApps()
    .filter((a) => !marketIds.has(normalizeId(a.id)))
    .map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      installed: true,
      notPublished: true,
      installedVersion: a.version,
    }));
  return [...marketMapped, ...installedOnly].filter((a) => a.kind !== 'system');
}

/**
 * Apps visible after applying the Hide Installed filter, the search-mode dropdown,
 * and the search query.
 *
 * - 'title'    — query matches name or description (the original behavior).
 * - 'author'   — query matches the author field instead.
 * - 'official' — restrict to YAAR-official apps; the query still filters within
 *                them by name/description.
 */
export function visibleApps(): DisplayApp[] {
  let apps = displayApps();
  if (hideInstalled()) apps = apps.filter((a) => !a.installed);

  const mode = searchMode();
  if (mode === 'official') {
    apps = apps.filter((a) => isOfficialAuthor(a.author));
  }

  const q = search().trim().toLowerCase();
  if (q) {
    apps =
      mode === 'author'
        ? apps.filter((a) => (a.author ?? '').toLowerCase().includes(q))
        : apps.filter(
            (a) =>
              a.name.toLowerCase().includes(q) || (a.description ?? '').toLowerCase().includes(q),
          );
  }
  return apps;
}
