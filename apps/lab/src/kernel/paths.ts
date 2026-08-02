/**
 * Path rules for the kernel's `store` helper.
 *
 *   "notebooks/x.json"                  -> this app's private storage (default)
 *   "app:foo.csv"                       -> this app's private storage, explicit
 *   "media/lab/chart.png"               -> the shared media tree
 *   "yaar://storage/media/lab/x.png"    -> the shared tree, absolute
 *   "yaar://apps/self/storage/x.json"   -> this app's private storage, absolute
 */
export function resolvePath(raw: string): { shared: boolean; path: string } {
  let p = String(raw || '').trim();
  if (!p) throw new Error('store: empty path');
  if (p.startsWith('yaar://apps/self/storage/')) {
    return { shared: false, path: p.slice('yaar://apps/self/storage/'.length) };
  }
  if (p.startsWith('yaar://storage/')) {
    return { shared: true, path: p.slice('yaar://storage/'.length) };
  }
  if (p.startsWith('app:')) return { shared: false, path: p.slice(4) };
  if (p.startsWith('shared:')) return { shared: true, path: p.slice(7) };
  if (p.startsWith('media/')) return { shared: true, path: p };
  if (p.startsWith('/')) p = p.slice(1);
  return { shared: false, path: p };
}
