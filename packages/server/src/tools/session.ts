/**
 * Session management tools for ClaudeOS.
 *
 * Provides tools for:
 * - Listing sessions
 * - Reading session transcripts
 * - Reading session messages
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  listSessions,
  readSessionTranscript,
  readSessionMessages,
} from '../sessions/index.js';

/**
 * List all sessions.
 */
export const listSessionsTool = tool(
  'list_sessions',
  'List all recorded sessions with their metadata',
  {},
  async () => {
    const sessions = await listSessions();

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          count: sessions.length,
          sessions: sessions.map(s => ({
            sessionId: s.sessionId,
            createdAt: s.metadata.createdAt,
            provider: s.metadata.provider,
            lastActivity: s.metadata.lastActivity,
          }))
        }, null, 2)
      }]
    };
  }
);

/**
 * Read a session transcript.
 */
export const readSessionTranscriptTool = tool(
  'read_session_transcript',
  'Read the human-readable transcript of a session',
  {
    sessionId: z.string().describe('The session ID to read')
  },
  async (args) => {
    const transcript = await readSessionTranscript(args.sessionId);

    if (!transcript) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: false, error: `Session "${args.sessionId}" not found` })
        }]
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: transcript
      }]
    };
  }
);

/**
 * Read session messages.
 */
export const readSessionMessagesTool = tool(
  'read_session_messages',
  'Read the raw messages log (JSONL format) of a session',
  {
    sessionId: z.string().describe('The session ID to read')
  },
  async (args) => {
    const messages = await readSessionMessages(args.sessionId);

    if (!messages) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: false, error: `Session "${args.sessionId}" not found` })
        }]
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: messages
      }]
    };
  }
);

/**
 * All session tools.
 */
export const sessionTools = [
  listSessionsTool,
  readSessionTranscriptTool,
  readSessionMessagesTool
];
