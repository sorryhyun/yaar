/**
 * Whose sandbox tabs an app may address — `browserId`s scoped per app.
 *
 * The headless pool is one namespace for every caller. An app picks its own ids
 * (`'live'`, `'reader'`), so two apps that picked the same one shared a tab — and a Dev
 * Tools preview is a second app built from the same source as the installed one, so it
 * always picked the same ones. Every preview mount ran the app's `shutdown()`, which closed
 * tab `'live'`: the installed copy's tab, with the user halfway through a Cloudflare check
 * in it (issue #187, item 4).
 *
 * So at the app door (`/api/browser`, its SSE/screenshot routes and the screencast socket)
 * an app's id is stored as `{appId}__{id}`. The app still speaks its own ids: everything
 * that goes back to it has its own prefix taken off, and an id that already carries the
 * prefix (one it read back from a window URL, say) is not prefixed twice. It cannot name a
 * tab outside its scope at all — asked for, that is a tab that does not exist.
 *
 * The Browser app is the exception: it is the viewer every other app's visible tab opens
 * in (`?browserId=` on its window), so it addresses the pool as it is. Agents reach the pool
 * through `yaar://session/browser` and `yaar://system/browsers`, which are not app doors and
 * see the stored ids.
 */

/** Between an app's id and the id it chose. App ids are kebab-case, so this cannot occur in one. */
const SEP = '__';

/** Apps that address every tab in the pool by its stored id. */
const POOL_VIEWER_APP_IDS = new Set(['browser']);

export interface TabScope {
  /** The app's id → the pool's. */
  toPool(id: string): string;
  /** The pool's id → the app's (unchanged for a tab outside the scope). */
  toApp(id: string): string;
  /** Whether a pool id is one this app may see. */
  owns(id: string): boolean;
  /** Take the scope's prefix off every pool id in an outgoing text. */
  toAppText(text: string): string;
}

const UNSCOPED: TabScope = {
  toPool: (id) => id,
  toApp: (id) => id,
  owns: () => true,
  toAppText: (text) => text,
};

/**
 * The scope an app's requests run in. No app id (no principal to scope by) is unscoped,
 * and so is the bundled Browser app — `systemApp` so that nothing else can claim its id.
 */
export function tabScopeFor(app: { appId?: string; systemApp?: boolean }): TabScope {
  const { appId } = app;
  if (!appId || (app.systemApp && POOL_VIEWER_APP_IDS.has(appId))) return UNSCOPED;
  const prefix = `${appId}${SEP}`;
  return {
    toPool: (id) => (id.startsWith(prefix) ? id : `${prefix}${id}`),
    toApp: (id) => (id.startsWith(prefix) ? id.slice(prefix.length) : id),
    owns: (id) => id.startsWith(prefix),
    toAppText: (text) => text.split(prefix).join(''),
  };
}

/** Every pool id an (ordinary, scoped) app owns. */
export function ownedBy(appId: string, ids: Iterable<string>): string[] {
  const scope = tabScopeFor({ appId });
  return [...ids].filter((id) => scope.owns(id));
}

/**
 * The id for a tab a page opened by itself (a popup): the opener's scope, so the app whose
 * page opened it can address it. Unscoped when the opener is unknown or unscoped.
 */
export function popupBrowserId(openerBrowserId: string | undefined, n: number): string {
  const at = openerBrowserId?.indexOf(SEP) ?? -1;
  return at > 0 ? `${openerBrowserId!.slice(0, at + SEP.length)}${n}` : String(n);
}
