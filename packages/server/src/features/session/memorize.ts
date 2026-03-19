/**
 * Memorize operation — persists notes to config/memory.md.
 *
 * Returns a plain result object, never VerbResult.
 */

import { configRead, configWrite } from '../../storage/storage-manager.js';

export interface MemorizeResult {
  success: boolean;
  error?: string;
}

/** Append content to the persistent memory file. */
export async function memorize(content: string): Promise<MemorizeResult> {
  const existing = await configRead('memory.md');
  const current = existing.success ? (existing.content ?? '') : '';
  const updated = current ? current.trimEnd() + '\n' + content : content;
  const result = await configWrite('memory.md', updated + '\n');
  if (!result.success) {
    return { success: false, error: `Failed to save memory: ${result.error}` };
  }
  return { success: true };
}
