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
        description: 'Add an AI response message to the chat',
        aliases: ['sendMessage', 'postMessage', 'appendMessage'],
        params: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            id: { type: 'string' },
          },
          required: ['content'],
        },
        handler: (p: Record<string, unknown>) => {
          finishWithMessage(
            makeMessage('assistant', p.content as string, 'done', p.id as string | undefined),
          );
        },
      },
      setError: {
        description: 'Show an error message',
        aliases: ['showError', 'displayError', 'addError'],
        params: {
          type: 'object',
          properties: { content: { type: 'string' } },
          required: ['content'],
        },
        handler: (p: Record<string, unknown>) => {
          finishWithMessage(
            makeMessage('assistant', p.content as string, 'error'),
          );
        },
      },
    },
  });
}
