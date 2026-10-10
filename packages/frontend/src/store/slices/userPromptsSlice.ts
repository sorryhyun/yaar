/**
 * User prompts slice — manages ask/request prompts from the agent.
 */
import type { SliceCreator } from '../types';
import type { UserPromptModel } from '@/types/state';
import type { UserPromptShowAction } from '@yaar/shared';
import { createApplyAction } from './apply-action-factory';

export interface UserPromptsSliceState {
  userPrompts: Record<string, UserPromptModel>;
  /**
   * Whether the prompts are open as a dialog. They arrive collapsed, as a notice the user
   * opens when ready: an agent's question used to take the whole screen the moment it
   * was asked, blocking everything until it was answered.
   */
  userPromptsOpen: boolean;
}

export interface UserPromptsSliceActions {
  dismissUserPrompt: (id: string) => void;
  setUserPromptsOpen: (open: boolean) => void;
}

export type UserPromptsSlice = UserPromptsSliceState & UserPromptsSliceActions;

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
    monitorId?: string;
    timestamp: number;
  },
  UserPromptShowAction
>(
  'userPrompts',
  'user.prompt.show',
  (action) => ({
    id: action.id,
    title: action.title,
    message: action.message,
    options: action.options,
    multiSelect: action.multiSelect,
    inputField: action.inputField,
    allowDismiss: action.allowDismiss,
    monitorId: action.monitorId,
    timestamp: Date.now(),
  }),
  'user.prompt.dismiss',
);

export const createUserPromptsSlice: SliceCreator<UserPromptsSlice> = (set, _get) => ({
  userPrompts: {},
  userPromptsOpen: false,

  dismissUserPrompt: (id) =>
    set((state) => {
      delete state.userPrompts[id];
    }),

  setUserPromptsOpen: (open) =>
    set((state) => {
      state.userPromptsOpen = open;
    }),
});
