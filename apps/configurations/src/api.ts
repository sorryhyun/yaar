import { read, showToast, errMsg } from '@bundled/yaar';
import * as z from '@bundled/zod';

/**
 * Generic loader for `yaar://config/*` list endpoints.
 *
 * Fetches `uri`, reads `data[key]`, validates it against `schema`, and calls
 * `setter` with the result.
 *
 * Failures are logged with the underlying cause and toasted, matching what
 * `domains-view` already did for its own load — so an empty list after this
 * returns silently means the config really is empty, not that the read broke.
 *
 * Recovery is **per entry**: one unreadable row is skipped and reported, and the
 * rest still render. Validating the array atomically would let a single hook the
 * schema does not recognise hide every hook the user has — including from the
 * delete button, which is the only way they could fix it.
 */
export async function loadConfigList<T>(
  uri: string,
  key: string,
  schema: z.ZodMiniType<T>,
  setter: (items: T[]) => void,
  label: string,
): Promise<void> {
  let raw: unknown;
  try {
    raw = await read<Record<string, unknown>>(uri);
  } catch (err) {
    console.error(`[configurations] failed to read ${uri}`, err);
    showToast(`Couldn't load ${label}: ${errMsg(err)}`, 'error');
    setter([]);
    return;
  }

  // A config file that doesn't exist yet reads as null/undefined, or as an
  // envelope without the key. That is the genuine "nothing configured" case, and
  // it stays quiet.
  const items = (raw as Record<string, unknown> | null | undefined)?.[key];
  if (items === undefined || items === null) {
    setter([]);
    return;
  }

  if (!Array.isArray(items)) {
    console.error(`[configurations] ${uri} → "${key}" is not an array`, items);
    showToast(`${label} config is malformed — see the console`, 'error');
    setter([]);
    return;
  }

  const good: T[] = [];
  let skipped = 0;
  for (const item of items) {
    const parsed = z.safeParse(schema, item);
    if (parsed.success) {
      good.push(parsed.data);
      continue;
    }
    skipped++;
    console.error(`[configurations] skipping an unreadable entry in ${uri} → "${key}"`, {
      item,
      issues: parsed.error.issues,
    });
  }

  if (skipped > 0) {
    showToast(`Skipped ${skipped} unreadable ${label} entr${skipped === 1 ? 'y' : 'ies'}`, 'error');
  }
  setter(good);
}
