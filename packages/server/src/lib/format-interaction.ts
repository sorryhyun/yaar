/**
 * Compact formatting for UserInteraction values.
 * Moved from @yaar/shared so the shared package stays focused on wire-protocol
 * types while the server owns the serialization logic used in context assembly.
 */
import type { UserInteraction } from '@yaar/shared';

/**
 * Format a UserInteraction into a compact ID-only string for the AI timeline.
 * e.g. "close:win-settings", "focus:win-main", "move:win-main {x:10,y:20,w:600,h:400}"
 */
export function formatCompactInteraction(interaction: UserInteraction): string {
  const verb = interaction.type.split('.')[1]; // 'close', 'focus', 'move', etc.
  const target = interaction.windowId ?? interaction.details ?? '';
  let result = target ? `${verb}:${target}` : verb;
  if (interaction.bounds) {
    const b = interaction.bounds;
    result += ` {x:${b.x},y:${b.y},w:${b.w},h:${b.h}}`;
  }
  if (interaction.instruction) {
    result += ` "${interaction.instruction}"`;
  }
  return result;
}
