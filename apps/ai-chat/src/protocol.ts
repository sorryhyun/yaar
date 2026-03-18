import { v4 as uuid } from '@bundled/uuid';
import { app } from '@bundled/yaar';
import { messages, setMessages, isWaiting, setIsWaiting } from './store';
import type { ChatMessage } from './types';

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
          const newMsg: ChatMessage = {
            id: (p.id as string) ?? uuid(),
            role: 'assistant',
            content: p.content as string,
            status: 'done',
            timestamp: Date.now(),
          };
          setMessages(prev => [...prev.filter(m => m.id !== 'typing-indicator'), newMsg]);
          setIsWaiting(false);
          return { ok: true };
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
          setMessages(prev => [...prev.filter(m => m.id !== 'typing-indicator'), {
            id: uuid(),
            role: 'assistant',
            content: p.content as string,
            status: 'error',
            timestamp: Date.now(),
          }]);
          setIsWaiting(false);
          return { ok: true };
        },
      },
    },
  });
}
