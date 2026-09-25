/**
 * Factory for the common show/dismiss action pattern used across overlay slices
 * (notifications, toasts, dialogs, user prompts).
 *
 * Each overlay slice stores items in a `Record<string, T>` and handles
 * a "show" action (upsert by id) and an optional "dismiss" action (delete by id).
 *
 * `TShowAction` and `TDismissAction` are the concrete `@yaar/shared` action interfaces for
 * the two branches. A call site names `TShowAction` as the factory's third type argument
 * (e.g. `createApplyAction<State, Item, DialogConfirmAction>(...)`), which types
 * `buildItem`'s parameter against that action's real fields instead of `any`.
 */
import type { OSAction } from '@yaar/shared';

export function createApplyAction<
  TState,
  TItem extends { id: string },
  TShowAction extends OSAction = OSAction,
  TDismissAction extends OSAction & { id: string } = OSAction & { id: string },
>(
  recordKey: string,
  showType: TShowAction['type'],
  buildItem: (action: TShowAction) => TItem,
  dismissType?: TDismissAction['type'],
): (state: TState, action: OSAction) => void {
  return (state: TState, action: OSAction) => {
    const record = (state as Record<string, Record<string, TItem>>)[recordKey];
    if (action.type === showType) {
      const item = buildItem(action as TShowAction);
      record[item.id] = item;
    } else if (dismissType && action.type === dismissType) {
      // `dismissType` is a runtime string, so the equality check above cannot narrow
      // `action`'s static type the way a literal comparison would — this cast is the one
      // place the branch still asserts rather than proves, backed by that check.
      delete record[(action as TDismissAction).id];
    }
  };
}
