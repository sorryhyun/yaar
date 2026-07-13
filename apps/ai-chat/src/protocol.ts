import { app, defineCommand } from '@bundled/yaar';
import { messages, isWaiting, finishWithMessage, isTurnAnswered } from './store';
import { makeMessage } from './helpers';

/** Registration is idempotent: a re-mount must not produce a second listener. */
let registered = false;

export function registerProtocol(): void {
  if (!app || registered) return;
  registered = true;
  
  app.register({
    appId: 'ai-chat',
    name: 'AI Chat',
    state: {
      messages: {
        description: 'All chat messages currently displayed in the conversation',
        handler: () =>
          messages().map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            status: m.status,
          })),
      },
      isWaiting: {
        description: 'Whether the app is waiting for an AI response',
        handler: () => isWaiting(),
      },
    },
    commands: {
      addMessage: defineCommand({
        description:
          'Add your reply to the chat. Call this EXACTLY ONCE per user message, and pass `replyTo` ' +
          'set to the msgId from the user_message interaction. A second call for the same replyTo ' +
          'is ignored and returns { added: false, reason: "already-answered" } — if you see that, ' +
          'the reply is already on screen, so stop and do not retry.',
        aliases: ['sendMessage', 'postMessage', 'appendMessage'],
        params: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The reply text to display.' },
            id: { type: 'string' },
            replyTo: {
              type: 'string',
              description: 'The msgId of the user message being answered (for de-duplication).',
            },
          },
          required: ['content'],
        },
        handler: (p) => {
          // Report the outcome instead of returning a bare success. The agent was
          // previously unable to tell an accepted reply from a dropped duplicate,
          // so it retried and double-answered.
          if (p.replyTo && isTurnAnswered(p.replyTo)) {
            finishWithMessage(makeMessage('assistant', p.content, 'done', p.id), p.replyTo);
            return { added: false, reason: 'already-answered', turn: p.replyTo };
          }
          finishWithMessage(makeMessage('assistant', p.content, 'done', p.id), p.replyTo);
          return { added: true, turn: p.replyTo ?? null };
        },
      }),
      setError: defineCommand({
        description:
          'Show an error message in the chat. Same one-call-per-turn contract as addMessage.',
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
        handler: (p) => {
          if (p.replyTo && isTurnAnswered(p.replyTo)) {
            finishWithMessage(makeMessage('assistant', p.content, 'error'), p.replyTo);
            return { added: false, reason: 'already-answered', turn: p.replyTo };
          }
          finishWithMessage(makeMessage('assistant', p.content, 'error'), p.replyTo);
          return { added: true, turn: p.replyTo ?? null };
        },
      }),
    },
  });
}
  