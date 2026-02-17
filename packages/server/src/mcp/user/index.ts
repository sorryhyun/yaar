/**
 * User interaction tools — ask and request.
 *
 * Lightweight prompts that let the agent clarify information (ask)
 * or delegate tasks to the user (request) without building full
 * component windows.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { actionEmitter } from '../action-emitter.js';
import { ok, error } from '../utils.js';

export const USER_TOOL_NAMES = ['ask', 'request'] as const;

export function registerUserTools(server: McpServer): void {
  // ask — structured clarification with options
  server.registerTool(
    'ask',
    {
      description:
        'Ask the user a question and wait for their answer. ' +
        'Shows a compact dialog with selectable options. ' +
        'Use for clarification before proceeding (e.g. "Which database?" or "Include tests?").',
      inputSchema: {
        title: z.string().describe('Short title for the prompt (e.g. "Database Choice")'),
        message: z.string().describe('The question to ask'),
        options: z
          .array(
            z.object({
              value: z.string().describe('Machine-readable value returned on selection'),
              label: z.string().describe('Human-readable label shown to user'),
              description: z.string().optional().describe('Optional explanation for this option'),
            }),
          )
          .min(2)
          .describe('Available options (minimum 2)'),
        multiSelect: z
          .boolean()
          .optional()
          .describe('Allow selecting multiple options (default: false)'),
        allowText: z
          .boolean()
          .optional()
          .describe('Include a freeform text field for "Other" responses (default: false)'),
      },
    },
    async (args) => {
      const result = await actionEmitter.showUserPrompt({
        title: args.title,
        message: args.message,
        options: args.options,
        multiSelect: args.multiSelect,
        inputField: args.allowText ? { placeholder: 'Type your answer…' } : undefined,
        allowDismiss: true,
      });

      if (result.dismissed) {
        return error('User dismissed the prompt without answering.');
      }

      const parts: string[] = [];
      if (result.selectedValues?.length) {
        parts.push(`Selected: ${result.selectedValues.join(', ')}`);
      }
      if (result.text) {
        parts.push(`Text: ${result.text}`);
      }
      return ok(parts.join('\n') || 'No selection made.');
    },
  );

  // request — delegate a task to the user with text response
  server.registerTool(
    'request',
    {
      description:
        'Request the user to perform an action and provide a text response. ' +
        'Shows a prompt with a text input field. ' +
        'Use when you need the user to do something you cannot ' +
        '(e.g. "Paste your API key", "Run this command and share the output", ' +
        '"Check the deployment URL and confirm it works").',
      inputSchema: {
        title: z.string().describe('Short title (e.g. "API Key Needed")'),
        message: z
          .string()
          .describe('What you need the user to do and why (be specific and helpful)'),
        inputLabel: z
          .string()
          .optional()
          .describe('Label for the text input (e.g. "API Key", "Command Output")'),
        inputPlaceholder: z.string().optional().describe('Placeholder text for the input field'),
        multiline: z
          .boolean()
          .optional()
          .describe('Use a multiline textarea instead of single-line input (default: false)'),
      },
    },
    async (args) => {
      const result = await actionEmitter.showUserPrompt({
        title: args.title,
        message: args.message,
        inputField: {
          label: args.inputLabel,
          placeholder: args.inputPlaceholder,
          type: args.multiline ? 'textarea' : 'text',
        },
        allowDismiss: true,
      });

      if (result.dismissed) {
        return error('User dismissed the request without responding.');
      }

      if (!result.text) {
        return error('User submitted an empty response.');
      }

      return ok(result.text);
    },
  );
}
