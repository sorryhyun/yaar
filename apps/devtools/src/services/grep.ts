export {};
import { invoke } from '@bundled/yaar';
import { activeProject } from '../core';

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

export async function grep(
  pattern: string,
  glob?: string,
): Promise<{ matches: GrepMatch[]; truncated?: boolean }> {
  const proj = activeProject();
  if (!proj) return { matches: [] };
  const storagePath = `projects/${proj.id}`;
  const result = await invoke<{ matches: GrepMatch[]; truncated?: boolean }>(
    `yaar://apps/self/storage/${storagePath}`,
    { action: 'grep', pattern, ...(glob ? { glob } : {}) },
  );
  return { matches: result?.matches ?? [], truncated: result?.truncated };
}
