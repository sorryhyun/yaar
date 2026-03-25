import { read } from '@bundled/yaar';

/**
 * Generic loader for yaar://config/* list endpoints.
 * Fetches `uri`, reads `data[key]`, and calls `setter` with the resulting array.
 * On any error, `setter` is called with an empty array.
 */
export async function loadConfigList<T>(
  uri: string,
  key: string,
  setter: (items: T[]) => void
): Promise<void> {
  try {
    const data = await read<Record<string, T[]>>(uri);
    setter(data?.[key] ?? []);
  } catch {
    setter([]);
  }
}
