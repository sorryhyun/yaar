/**
 * User prompts slice — manages ask/request prompts from the agent.
 */
import type { SliceCreator, UserPromptsSlice, UserPromptsSliceState } from '../types';
import type { OSAction, UserPromptShowAction } from '@yaar/shared';

/**
 * Pure mutation function that applies a user prompt action to an Immer draft.
 */
export function applyUserPromptAction(state: UserPromptsSliceState, action: OSAction): void {
  switch (action.type) {
    case 'user.prompt.show': {
      const a = action as UserPromptShowAction;
      state.userPrompts[a.id] = {
        id: a.id,
        title: a.title,
        message: a.message,
        options: a.options,
        multiSelect: a.multiSelect,
        inputField: a.inputField,
        allowDismiss: a.allowDismiss,
        timestamp: Date.now(),
      };
      break;
    }
    case 'user.prompt.dismiss': {
      const id = (action as { id: string }).id;
      delete state.userPrompts[id];
      break;
    }
  }
}

export const createUserPromptsSlice: SliceCreator<UserPromptsSlice> = (set, _get) => ({
  userPrompts: {},

  handleUserPromptAction: (action: OSAction) =>
    set((state) => {
      applyUserPromptAction(state, action);
    }),

  dismissUserPrompt: (id) =>
    set((state) => {
      delete state.userPrompts[id];
    }),
});
