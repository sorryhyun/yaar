/**
 * Session logging for ClaudeOS.
 *
 * Logs session activity to disk for debugging and replay purposes.
 * Sessions are stored in session_logs/{timestamp}/
 */

import { mkdir, writeFile, readFile, readdir, appendFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { OSAction } from '@claudeos/shared';

// Project root directory (3 levels up from this file: sessions -> src -> server -> packages -> root)
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..', '..');
const SESSIONS_DIR = join(PROJECT_ROOT, 'session_logs');

export interface AgentInfo {
  agentId: string;
  parentAgentId: string | null;
  windowId?: string;
  createdAt: string;
}

export interface SessionMetadata {
  createdAt: string;
  provider: string;
  lastActivity: string;
  agents: Record<string, AgentInfo>; // agentId -> AgentInfo
}

export interface SessionInfo {
  sessionId: string;
  directory: string;
  metadata: SessionMetadata;
}

/**
 * Ensure the sessions directory exists.
 */
async function ensureSessionsDir(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

/**
 * Generate a unique session ID based on timestamp.
 */
function generateSessionId(): string {
  // Format: YYYY-MM-DD_HH-MM-SS
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().split(' ')[0].replace(/:/g, '-');
  return `${date}_${time}`;
}

/**
 * Create a new session.
 */
export async function createSession(provider: string): Promise<SessionInfo> {
  await ensureSessionsDir();

  const sessionId = generateSessionId();
  const directory = join(SESSIONS_DIR, sessionId);

  await mkdir(directory, { recursive: true });
  await mkdir(join(directory, 'agents'), { recursive: true });

  const now = new Date().toISOString();
  const metadata: SessionMetadata = {
    createdAt: now,
    provider,
    lastActivity: now,
    agents: {
      default: {
        agentId: 'default',
        parentAgentId: null,
        createdAt: now,
      },
    },
  };

  await writeFile(
    join(directory, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );

  // Create main files
  await writeFile(join(directory, 'transcript.md'), '# Session Transcript\n\n');
  await writeFile(join(directory, 'messages.jsonl'), '');

  // Create default agent transcript
  await writeFile(join(directory, 'agents', 'default.md'), '# Default Agent\n\n');

  return { sessionId, directory, metadata };
}

/**
 * Session logger for recording session activity.
 */
export class SessionLogger {
  private sessionInfo: SessionInfo;

  constructor(sessionInfo: SessionInfo) {
    this.sessionInfo = sessionInfo;
  }

  /**
   * Register a new agent in the session hierarchy.
   */
  async registerAgent(
    agentId: string,
    parentAgentId: string | null,
    windowId?: string
  ): Promise<void> {
    if (this.sessionInfo.metadata.agents[agentId]) {
      return; // Already registered
    }

    const agentInfo: AgentInfo = {
      agentId,
      parentAgentId,
      windowId,
      createdAt: new Date().toISOString(),
    };

    this.sessionInfo.metadata.agents[agentId] = agentInfo;

    // Create agent-specific transcript file
    const agentFilename = agentId.replace(/[^a-zA-Z0-9-_]/g, '_');
    const parentInfo = parentAgentId ? ` (forked from ${parentAgentId})` : '';
    const windowInfo = windowId ? ` for window ${windowId}` : '';
    await writeFile(
      join(this.sessionInfo.directory, 'agents', `${agentFilename}.md`),
      `# Agent: ${agentId}${parentInfo}${windowInfo}\n\n`
    );

    // Update metadata
    await this.saveMetadata();
  }

  /**
   * Get the agent hierarchy path (e.g., "default → window-win1 → window-win2")
   */
  getAgentPath(agentId: string): string {
    const path: string[] = [];
    let currentId: string | null = agentId;

    while (currentId) {
      path.unshift(currentId);
      const info: AgentInfo | undefined = this.sessionInfo.metadata.agents[currentId];
      currentId = info?.parentAgentId ?? null;
    }

    return path.join(' → ');
  }

  /**
   * Get the nesting depth of an agent.
   */
  private getAgentDepth(agentId: string): number {
    let depth = 0;
    let currentId: string | null = agentId;

    while (currentId) {
      const info: AgentInfo | undefined = this.sessionInfo.metadata.agents[currentId];
      currentId = info?.parentAgentId ?? null;
      if (currentId) depth++;
    }

    return depth;
  }

  /**
   * Log a user message.
   */
  async logUserMessage(content: string, agentId?: string): Promise<void> {
    const timestamp = new Date().toISOString();
    const agent = agentId ?? 'default';
    const parentAgentId = this.sessionInfo.metadata.agents[agent]?.parentAgentId ?? null;
    const depth = this.getAgentDepth(agent);
    const indent = '  '.repeat(depth);

    // Append to main transcript with indentation for hierarchy
    await appendFile(
      join(this.sessionInfo.directory, 'transcript.md'),
      `\n${indent}## User → ${agent} (${timestamp})\n\n${indent}${content.split('\n').join(`\n${indent}`)}\n`
    );

    // Append to agent-specific transcript
    const agentFilename = agent.replace(/[^a-zA-Z0-9-_]/g, '_');
    try {
      await appendFile(
        join(this.sessionInfo.directory, 'agents', `${agentFilename}.md`),
        `\n## User (${timestamp})\n\n${content}\n`
      );
    } catch {
      // Agent file might not exist yet
    }

    // Append to messages log with parent info
    await appendFile(
      join(this.sessionInfo.directory, 'messages.jsonl'),
      JSON.stringify({ type: 'user', timestamp, agentId: agent, parentAgentId, content }) + '\n'
    );
  }

  /**
   * Log an assistant message.
   */
  async logAssistantMessage(content: string, agentId?: string): Promise<void> {
    const timestamp = new Date().toISOString();
    const agent = agentId ?? 'default';
    const parentAgentId = this.sessionInfo.metadata.agents[agent]?.parentAgentId ?? null;
    const depth = this.getAgentDepth(agent);
    const indent = '  '.repeat(depth);

    // Append to main transcript with indentation
    await appendFile(
      join(this.sessionInfo.directory, 'transcript.md'),
      `\n${indent}## ${agent} (${timestamp})\n\n${indent}${content.split('\n').join(`\n${indent}`)}\n`
    );

    // Append to agent-specific transcript
    const agentFilename = agent.replace(/[^a-zA-Z0-9-_]/g, '_');
    try {
      await appendFile(
        join(this.sessionInfo.directory, 'agents', `${agentFilename}.md`),
        `\n## Assistant (${timestamp})\n\n${content}\n`
      );
    } catch {
      // Agent file might not exist yet
    }

    // Append to messages log with parent info
    await appendFile(
      join(this.sessionInfo.directory, 'messages.jsonl'),
      JSON.stringify({ type: 'assistant', timestamp, agentId: agent, parentAgentId, content }) + '\n'
    );
  }

  /**
   * Log an OS action.
   */
  async logAction(action: OSAction, agentId?: string): Promise<void> {
    const timestamp = new Date().toISOString();
    const agent = agentId ?? 'default';
    const parentAgentId = this.sessionInfo.metadata.agents[agent]?.parentAgentId ?? null;

    // Append to messages log with parent info
    await appendFile(
      join(this.sessionInfo.directory, 'messages.jsonl'),
      JSON.stringify({ type: 'action', timestamp, agentId: agent, parentAgentId, action }) + '\n'
    );
  }

  /**
   * Update the last activity timestamp.
   */
  async updateLastActivity(): Promise<void> {
    this.sessionInfo.metadata.lastActivity = new Date().toISOString();
    await this.saveMetadata();
  }

  /**
   * Save metadata to disk.
   */
  private async saveMetadata(): Promise<void> {
    await writeFile(
      join(this.sessionInfo.directory, 'metadata.json'),
      JSON.stringify(this.sessionInfo.metadata, null, 2)
    );
  }
}

/**
 * List all sessions.
 */
export async function listSessions(): Promise<SessionInfo[]> {
  await ensureSessionsDir();

  const entries = await readdir(SESSIONS_DIR, { withFileTypes: true });
  const sessions: SessionInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const directory = join(SESSIONS_DIR, entry.name);
    const metadataPath = join(directory, 'metadata.json');

    try {
      const metadataContent = await readFile(metadataPath, 'utf-8');
      const rawMetadata = JSON.parse(metadataContent);

      // Handle backward compatibility - add agents field if missing
      const metadata: SessionMetadata = {
        ...rawMetadata,
        agents: rawMetadata.agents ?? {
          default: {
            agentId: 'default',
            parentAgentId: null,
            createdAt: rawMetadata.createdAt,
          },
        },
      };

      sessions.push({
        sessionId: entry.name,
        directory,
        metadata,
      });
    } catch {
      // Skip invalid sessions
    }
  }

  // Sort by creation date, newest first
  sessions.sort((a, b) =>
    new Date(b.metadata.createdAt).getTime() - new Date(a.metadata.createdAt).getTime()
  );

  return sessions;
}

/**
 * Read a session transcript.
 */
export async function readSessionTranscript(sessionId: string): Promise<string | null> {
  const transcriptPath = join(SESSIONS_DIR, sessionId, 'transcript.md');

  try {
    return await readFile(transcriptPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Read session messages.
 */
export async function readSessionMessages(sessionId: string): Promise<string | null> {
  const messagesPath = join(SESSIONS_DIR, sessionId, 'messages.jsonl');

  try {
    return await readFile(messagesPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Parsed message from messages.jsonl
 */
export interface ParsedMessage {
  type: 'user' | 'assistant' | 'action';
  timestamp: string;
  agentId: string;
  parentAgentId: string | null;
  content?: string;
  action?: OSAction;
}

/**
 * Parse session messages from JSONL format.
 */
export function parseSessionMessages(messagesJsonl: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  const lines = messagesJsonl.trim().split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ParsedMessage;
      messages.push(parsed);
    } catch {
      // Skip invalid lines
    }
  }

  return messages;
}

/**
 * Extract window restore actions from parsed messages.
 * Returns the final state of all windows that should still be open.
 */
export function getWindowRestoreActions(messages: ParsedMessage[]): OSAction[] {
  // Track window states by ID
  const windows = new Map<string, OSAction>();

  for (const msg of messages) {
    if (msg.type !== 'action' || !msg.action) continue;
    const action = msg.action;

    switch (action.type) {
      case 'window.create':
        // Store the create action
        windows.set(action.windowId, { ...action });
        break;

      case 'window.close':
        // Remove the window
        windows.delete(action.windowId);
        break;

      case 'window.updateContent': {
        // Apply content update to stored window
        const win = windows.get(action.windowId);
        if (win && win.type === 'window.create') {
          // Apply the operation to the stored content
          const currentData = win.content?.data ?? '';
          const newRenderer = action.renderer ?? win.content?.renderer ?? 'text';

          let newData: unknown = currentData;
          switch (action.operation.op) {
            case 'replace':
              newData = action.operation.data;
              break;
            case 'append':
              if (typeof currentData === 'string' && typeof action.operation.data === 'string') {
                newData = currentData + action.operation.data;
              } else {
                newData = action.operation.data;
              }
              break;
            case 'prepend':
              if (typeof currentData === 'string' && typeof action.operation.data === 'string') {
                newData = action.operation.data + currentData;
              } else {
                newData = action.operation.data;
              }
              break;
            case 'clear':
              newData = '';
              break;
            case 'insertAt':
              if (typeof currentData === 'string' && typeof action.operation.data === 'string') {
                const pos = action.operation.position ?? 0;
                newData = currentData.slice(0, pos) + action.operation.data + currentData.slice(pos);
              }
              break;
          }

          win.content = {
            renderer: newRenderer,
            data: newData,
          };
        }
        break;
      }

      case 'window.setTitle': {
        const win = windows.get(action.windowId);
        if (win && win.type === 'window.create') {
          win.title = action.title;
        }
        break;
      }

      case 'window.move': {
        const win = windows.get(action.windowId);
        if (win && win.type === 'window.create' && win.bounds) {
          win.bounds.x = action.x;
          win.bounds.y = action.y;
        }
        break;
      }

      case 'window.resize': {
        const win = windows.get(action.windowId);
        if (win && win.type === 'window.create' && win.bounds) {
          win.bounds.w = action.w;
          win.bounds.h = action.h;
        }
        break;
      }

      case 'window.lock': {
        const win = windows.get(action.windowId);
        if (win && win.type === 'window.create') {
          // Don't restore locked state - windows should start unlocked
        }
        break;
      }

      case 'window.unlock': {
        // Already handled by not restoring locked state
        break;
      }
    }
  }

  return Array.from(windows.values());
}
