/**
 * Action parser - extracts OS Actions from AI response text.
 *
 * The AI emits actions as JSON code blocks. We find and parse these
 * to control the UI.
 */

import type { OSAction } from '@claudeos/shared';

/**
 * Pattern to find OS Action JSON blocks in response text.
 *
 * Matches:
 * ```json
 * {"type": "window.create", ...}
 * ```
 *
 * Or without language specifier:
 * ```
 * {"type": "toast.show", ...}
 * ```
 */
const ACTION_PATTERN =
  /```(?:json)?\s*\n(\{[^`]*"type"\s*:\s*"(?:window|notification|toast)[^`]*\})\s*\n```/gm;

/**
 * Extract OS Action JSON blocks from response text.
 */
export function extractActions(text: string): OSAction[] {
  const actions: OSAction[] = [];

  let match: RegExpExecArray | null;
  while ((match = ACTION_PATTERN.exec(text)) !== null) {
    try {
      const action = JSON.parse(match[1]) as Record<string, unknown>;

      if (typeof action === 'object' && action !== null && 'type' in action) {
        const actionType = String(action.type);

        // Only accept known action prefixes
        if (
          actionType.startsWith('window.') ||
          actionType.startsWith('notification.') ||
          actionType.startsWith('toast.')
        ) {
          actions.push(action as unknown as OSAction);
        }
      }
    } catch {
      // Skip invalid JSON
      continue;
    }
  }

  // Reset regex lastIndex for next call
  ACTION_PATTERN.lastIndex = 0;

  return actions;
}
