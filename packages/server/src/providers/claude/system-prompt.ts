/**
 * System prompt for the YAAR desktop agent (Claude provider).
 * Override by placing a custom prompt in config/system-prompt.txt.
 */

import { loadCustomSystemPrompt } from '../load-system-prompt.js';
import { VERB_MODE_PROMPT } from './system-prompt-verb.js';

const customPrompt = loadCustomSystemPrompt();

export function getSystemPrompt(): string {
  return customPrompt ?? VERB_MODE_PROMPT;
}
