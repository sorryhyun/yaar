import { app } from '@bundled/yaar';
import { messages, isWaiting, finishWithMessage } from './store';
import { makeMessage } from './helpers';

export function registerProtocol() {
  if (!app) return;

  app.register({
    appId: 'ai-chat',
    name: 'AI Chat',
    state: {
      messages: {
        description: 'All chat messages',
        handler: () => messages().map(m => ({ id: m.id, role: m.role, content: m.content })),
      },
      isWaiting: {
        description: 'Whether app is waiting for AI response',
        handler: () => isWaiting(),
      },
    },
    commands: {
      addMessage: {
        description:
          'Add an AI response message to the chat. Call this EXACTLY ONCE per user message. ' +
          'Pass `replyTo` set to the msgId from the user_message interaction so repeated/trailing ' +
          'emits for the same turn are ignored.',
        aliases: ['sendMessage', 'postMessage', 'appendMessage'],
        params: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            id: { type: 'string' },
            replyTo: {
              type: 'string',
              description: 'The msgId of the user message being answered (for de-duplication).',
            },
          },
          required: ['content'],
        },
        handler: (p: Record<string, unknown>) => {
          finishWithMessage(
            makeMessage('assistant', p.content as string, 'done', p.id as string | undefined),
            p.replyTo as string | undefined,
          );
        },
      },
      setError: {
        description: 'Show an error message',
        aliases: ['showError', 'displayError', 'addError'],
        params: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            replyTo: {
              type: 'string',
              description: 'The msgId of the user message being answered (for de-duplication).',
            },
          },
          required: ['content'],
        },
        handler: (p: Record<string, unknown>) => {
          finishWithMessage(
            makeMessage('assistant', p.content as string, 'error'),
            p.replyTo as string | undefined,
          );
        },
      },
    },
  });
}
