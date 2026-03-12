/**
 * User prompts slice — manages ask/request prompts from the agent.
 */
import type { SliceCreator, UserPromptsSlice, UserPromptsSliceState } from '../types';
import type { OSAction, UserPromptShowAction } from '@yaar/shared';
import { createApplyAction } from './apply-action-factory';

/**
 * Pure mutation function that applies a user prompt action to an Immer draft.
 */
export const applyUserPromptAction = createApplyAction<
  UserPromptsSliceState,
  {
    id: string;
    title: string;
    message: string;
    options?: UserPromptShowAction['options'];
    multiSelect?: boolean;
    inputField?: UserPromptShowAction['inputField'];
    allowDismiss?: boolean;
    timestamp: number;
  }
>(
  'userPrompts',
  'user.prompt.show',
  (action: UserPromptShowAction) => ({
    id: action.id,
    title: action.title,
    message: action.message,
    options: action.options,
    multiSelect: action.multiSelect,
    inputField: action.inputField,
    allowDismiss: action.allowDismiss,
    timestamp: Date.now(),
  }),
  'user.prompt.dismiss',
);

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
