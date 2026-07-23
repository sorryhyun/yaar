/**
 * Factory for the common show/dismiss action pattern used across overlay slices
 * (notifications, toasts, dialogs, user prompts).
 *
 * Each overlay slice stores items in a `Record<string, T>` and handles
 * a "show" action (upsert by id) and an optional "dismiss" action (delete by id).
 */
import type { OSAction } from '@yaar/shared';

export function createApplyAction<TState, TItem extends { id: string }>(
  recordKey: string,
  showType: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildItem: (action: any) => TItem,
  dismissType?: string,
): (state: TState, action: OSAction) => void {
  return (state: TState, action: OSAction) => {
    const record = (state as Record<string, Record<string, TItem>>)[recordKey];
    if (action.type === showType) {
      record[(action as unknown as { id: string }).id] = buildItem(action);
    } else if (dismissType && action.type === dismissType) {
      delete record[(action as unknown as { id: string }).id];
    }
  };
}
