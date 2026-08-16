// App-id normalization. Ids arrive from three places that disagree about case and
// padding (the catalog, the host list, the account's owned-app list), so every
// comparison in the app funnels through here rather than using `===` on raw ids.

export function normalizeId(value: string): string {
  return (value || '').trim().toLowerCase();
}

export function sameAppId(a: string, b: string): boolean {
  return normalizeId(a) === normalizeId(b);
}

/** Returns the first truthy string among the given candidates, or null. */
export function firstString(...values: unknown[]): string | null {
  for (const v of values) if (typeof v === 'string' && v) return v;
  return null;
}
