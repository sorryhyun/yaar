/**
 * History domain handlers — read-only access to past session logs.
 *
 *   list('yaar://history/')                          → list all past sessions
 *   read('yaar://history/')                          → session summaries as JSON
 *   read('yaar://history/{id}')                      → session metadata
 *   read('yaar://history/{id}/transcript')            → markdown transcript
 *   read('yaar://history/{id}/messages')              → structured parsed messages
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import type { ResolvedUri, ResolvedHistory } from './uri-resolve.js';
import { okJsonResource, okLinks, okResource, error, getActiveSession } from './utils.js';
import {
  listSessions,
  readSessionTranscript,
  readSessionMessages,
  parseSessionMessages,
} from '../logging/session-reader.js';

export function registerHistoryHandlers(registry: ResourceRegistry): void {
  registry.register('yaar://history/', {
    description:
      'Past session logs (read-only). List for links, read for summaries, or read yaar://history/{id}[/transcript|/messages] for detail.',
    verbs: ['describe', 'list', 'read'],

    async list(): Promise<VerbResult> {
      const sessions = await listSessions();
      const pool = getActiveSession().getPool();
      const currentLogId = pool?.getLogSessionId();
      return okLinks(
        sessions.map((s) => ({
          uri: `yaar://history/${s.sessionId}`,
          name: s.sessionId,
          description: `${s.metadata.provider} | ${s.metadata.createdAt}${s.sessionId === currentLogId ? ' (current)' : ''}`,
          mimeType: 'text/plain',
        })),
      );
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      if (resolved.kind === 'history') {
        const hr = resolved as ResolvedHistory;

        // Specific session: yaar://history/{id}[/transcript|/messages]
        if (hr.sessionId) {
          const logId = hr.sessionId;

          if (hr.subPath === 'transcript') {
            const transcript = await readSessionTranscript(logId);
            if (transcript === null) return error(`Session "${logId}" not found.`);
            return okResource(resolved.sourceUri, transcript, 'text/plain');
          }

          if (hr.subPath === 'messages') {
            const messagesJsonl = await readSessionMessages(logId);
            if (messagesJsonl === null) return error(`Session "${logId}" not found.`);
            const messages = parseSessionMessages(messagesJsonl);
            return okJsonResource(resolved.sourceUri, { messages });
          }

          // yaar://history/{id} — session detail with metadata
          const sessions = await listSessions();
          const session = sessions.find((s) => s.sessionId === logId);
          if (!session) return error(`Session "${logId}" not found.`);

          const pool = getActiveSession().getPool();
          const currentLogId = pool?.getLogSessionId();
          return okJsonResource(resolved.sourceUri, {
            sessionId: session.sessionId,
            createdAt: session.metadata.createdAt,
            provider: session.metadata.provider,
            lastActivity: session.metadata.lastActivity,
            agentCount: Object.keys(session.metadata.agents ?? {}).length,
            agents: session.metadata.agents,
            threadIds: session.metadata.threadIds,
            failureCount: session.metadata.failureCount,
            isCurrent: session.sessionId === currentLogId,
          });
        }
      }

      // Root: yaar://history/
      const sessions = await listSessions();
      const pool = getActiveSession().getPool();
      const currentLogId = pool?.getLogSessionId();
      return okJsonResource('yaar://history/', {
        currentSessionId: currentLogId ?? null,
        sessions: sessions.map((s) => ({
          sessionId: s.sessionId,
          createdAt: s.metadata.createdAt,
          provider: s.metadata.provider,
          lastActivity: s.metadata.lastActivity,
          agentCount: Object.keys(s.metadata.agents ?? {}).length,
        })),
      });
    },
  });
}
