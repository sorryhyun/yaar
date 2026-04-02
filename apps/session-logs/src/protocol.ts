import { app } from '@bundled/yaar';
import { state } from './store';
import { loadSessions, loadDetail } from './api';

export function registerProtocol(): void {
  if (!app) return;

  app.register({
    appId: 'session-logs',
    name: 'Session Logs',
    state: {
      sessions: {
        description: 'List of session summaries (id, provider, date, agentCount)',
        handler: () =>
          state.sessions.length
            ? {
                currentSessionId: state.currentSessionId || null,
                total: state.sessions.length,
                sessions: state.sessions,
              }
            : null,
      },
      selectedSession: {
        description: 'Currently selected session detail object',
        handler: () => state.detail,
      },
      transcript: {
        description: 'Markdown transcript of the selected session',
        handler: () => state.transcript,
      },
      messages: {
        description: 'Structured parsed messages array for the selected session',
        handler: () =>
          state.messages ? { count: state.messages.length, messages: state.messages } : null,
      },
    },
    commands: {
      selectSession: {
        description: 'Select and load a session by ID (loads transcript and messages)',
        params: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'Session ID to load' },
          },
          required: ['sessionId'],
        },
        handler: async (params: Record<string, unknown>) => {
          const sessionId = String(params.sessionId);
          await loadDetail(sessionId);
          return { success: true, sessionId };
        },
      },
      refresh: {
        description: 'Reload the session list from disk',
        params: { type: 'object', properties: {} },
        handler: async () => {
          await loadSessions();
          return { success: true, count: state.sessions.length };
        },
      },
    },
  });
}
