export {};
import { invoke } from '@bundled/yaar';
import { activeProject } from '../core';
import { isGeneratedPath } from '../lib';

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

/**
 * Regex search across the active project, with generated output filtered out unless
 * `includeBuilt` asks for it.
 *
 * The filter runs here and not on the server: the storage grep action takes one positive
 * glob and no exclusions, so a negative filter cannot be expressed as a query. That means
 * the server searches the bundle, counts its hits against its own cap, and only then hands
 * them over to be dropped — so a truncated search of a built project can still be missing
 * source matches. `excluded` reports how many were dropped, which is what lets the caller
 * say that rather than present a short result as a complete one.
 */
export async function grep(
  pattern: string,
  glob?: string,
  includeBuilt = false,
): Promise<{ matches: GrepMatch[]; truncated?: boolean; excluded?: number }> {
  const proj = activeProject();
  if (!proj) return { matches: [] };
  const storagePath = `projects/${proj.id}`;
  const result = await invoke<{ matches: GrepMatch[]; truncated?: boolean }>(
    `yaar://apps/self/storage/${storagePath}`,
    { action: 'grep', pattern, ...(glob ? { glob } : {}) },
  );
  const matches = result?.matches ?? [];
  if (includeBuilt) return { matches, truncated: result?.truncated };
  const kept = matches.filter((m) => !isGeneratedPath(m.file));
  return {
    matches: kept,
    truncated: result?.truncated,
    ...(kept.length < matches.length ? { excluded: matches.length - kept.length } : {}),
  };
}
