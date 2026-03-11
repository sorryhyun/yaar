import { v4 as uuid } from '@bundled/uuid';
import { messages, setMessages, setIsWaiting } from './store';
import type { ChatMessage } from './types';

export function registerProtocol() {
  if (!window.yaar?.app) return;

  window.yaar.app.register({
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
        params: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            id: { type: 'string' },
          },
          required: ['content'],
        },
        handler: (p: { content: string; id?: string }) => {
          const newMsg: ChatMessage = {
            id: p.id ?? uuid(),
            role: 'assistant',
            content: p.content,
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
        params: {
          type: 'object',
          properties: { content: { type: 'string' } },
          required: ['content'],
        },
        handler: (p: { content: string }) => {
          setMessages(prev => [...prev.filter(m => m.id !== 'typing-indicator'), {
            id: uuid(),
            role: 'assistant',
            content: p.content,
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
