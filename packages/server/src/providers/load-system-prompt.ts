/**
 * Load a custom system prompt from config/system-prompt.txt if it exists.
 * Returns the custom prompt text, or null to use the provider default.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getConfigDir } from '../config.js';

const CUSTOM_PROMPT_FILE = 'system-prompt.txt';

let cached: string | null | undefined;

export function loadCustomSystemPrompt(): string | null {
  if (cached !== undefined) return cached;

  const path = join(getConfigDir(), CUSTOM_PROMPT_FILE);
  if (existsSync(path)) {
    try {
      const content = readFileSync(path, 'utf-8').trim();
      if (content) {
        console.log(`[SystemPrompt] Using custom prompt from ${path}`);
        cached = content;
        return cached;
      }
    } catch {
      // fall through to default
    }
  }

  cached = null;
  return null;
}
