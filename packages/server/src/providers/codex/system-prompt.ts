/**
 * System prompt for the YAAR desktop agent (Codex provider).
 * Uses the same verb-mode prompt as Claude since Codex only supports verb mode.
 * Override by placing a custom prompt in config/system-prompt.txt.
 */

import { loadCustomSystemPrompt } from '../load-system-prompt.js';
import { VERB_MODE_PROMPT } from '../claude/system-prompt-verb.js';

export const SYSTEM_PROMPT = loadCustomSystemPrompt() ?? VERB_MODE_PROMPT;
