/**
 * User prompt business logic.
 *
 * Handles asking the user multiple-choice questions and requesting freeform text input.
 */

import { actionEmitter } from '../../session/action-emitter.js';

/**
 * A prompt nobody answered is not a prompt the user turned down. Both used to arrive here
 * as `dismissed`, so an agent that asked a question while the user was away was told they
 * had declined to answer it — and would act on a refusal that never happened.
 */
const EXPIRED_ERROR =
  'The prompt expired with no answer and was withdrawn from the screen. The user did not ' +
  'decline — they never answered. Ask again if you still need it, or proceed without it.';

export interface AskUserPayload {
  title: string;
  message: string;
  options: Array<{ value: string; label: string; description?: string }>;
  multiSelect?: boolean;
  allowText?: boolean;
}

export interface RequestUserInputPayload {
  title: string;
  message: string;
  inputLabel?: string;
  inputPlaceholder?: string;
  multiline?: boolean;
}

export interface PromptResult {
  success: boolean;
  result?: string;
  text?: string;
  error?: string;
}

/**
 * Ask the user a multiple-choice question.
 *
 * Validates that at least 2 options are provided, shows the prompt,
 * and formats the result. Returns plain data, not VerbResult.
 */
export async function askUser(payload: AskUserPayload): Promise<PromptResult> {
  if (!payload.options || !Array.isArray(payload.options) || payload.options.length < 2) {
    return { success: false, error: '"options" (array of at least 2) is required for "ask".' };
  }

  const result = await actionEmitter.showUserPrompt({
    title: payload.title,
    message: payload.message,
    options: payload.options,
    multiSelect: payload.multiSelect,
    inputField: payload.allowText ? { placeholder: 'Type your answer...' } : undefined,
    allowDismiss: true,
  });

  if (result.timedOut) {
    return { success: false, error: EXPIRED_ERROR };
  }
  if (result.dismissed) {
    return { success: false, error: 'User dismissed the prompt without answering.' };
  }

  const parts: string[] = [];
  if (result.selectedValues?.length) parts.push(`Selected: ${result.selectedValues.join(', ')}`);
  if (result.text) parts.push(`Text: ${result.text}`);

  return { success: true, result: parts.join('\n') || 'No selection made.' };
}

/**
 * Request freeform text input from the user.
 *
 * Shows a text input prompt and returns the user's response.
 * Returns plain data, not VerbResult.
 */
export async function requestUserInput(payload: RequestUserInputPayload): Promise<PromptResult> {
  const result = await actionEmitter.showUserPrompt({
    title: payload.title,
    message: payload.message,
    inputField: {
      label: payload.inputLabel,
      placeholder: payload.inputPlaceholder,
      type: payload.multiline ? 'textarea' : 'text',
    },
    allowDismiss: true,
  });

  if (result.timedOut) {
    return { success: false, error: EXPIRED_ERROR };
  }
  if (result.dismissed) {
    return { success: false, error: 'User dismissed the request without responding.' };
  }
  if (!result.text) {
    return { success: false, error: 'User submitted an empty response.' };
  }

  return { success: true, text: result.text };
}
