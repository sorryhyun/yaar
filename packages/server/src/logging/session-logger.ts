import { mkdir, writeFile, appendFile } from 'fs/promises';
import { join } from 'path';
import type { OSAction, UserInteraction } from '@yaar/shared';
import { formatCompactInteraction } from '@yaar/shared';
import { SESSIONS_DIR, ensureSessionsDir } from './index.js';
import type { AgentInfo, SessionInfo, SessionMetadata } from './types.js';
import type { ContextSource } from '../agents/context.js';

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

  // Create main messages log
  await writeFile(join(directory, 'messages.jsonl'), '');

  // Create default agent JSONL log
  await writeFile(join(directory, 'agents', 'default.jsonl'), '');

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

    // Create agent-specific JSONL file (empty, entries appended later)
    const agentFilename = agentId.replace(/[^a-zA-Z0-9-_]/g, '_');
    await writeFile(
      join(this.sessionInfo.directory, 'agents', `${agentFilename}.jsonl`),
      ''
    );

    // Update metadata
    await this.saveMetadata();
  }

  /**
   * Append a structured entry to both global and per-agent logs.
   */
  private async appendEntry(
    type: string,
    agentId: string | undefined,
    fields: Record<string, unknown>
  ): Promise<void> {
    const agent = agentId ?? 'default';
    const parentAgentId = this.sessionInfo.metadata.agents[agent]?.parentAgentId ?? null;
    const entry = { type, timestamp: new Date().toISOString(), agentId: agent, parentAgentId, ...fields };

    // Append to global messages log
    await appendFile(
      join(this.sessionInfo.directory, 'messages.jsonl'),
      JSON.stringify(entry) + '\n'
    );

    // Append to per-agent JSONL
    const agentFilename = agent.replace(/[^a-zA-Z0-9-_]/g, '_');
    try {
      await appendFile(
        join(this.sessionInfo.directory, 'agents', `${agentFilename}.jsonl`),
        JSON.stringify(entry) + '\n'
      );
    } catch {
      // Agent file might not exist yet
    }
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

  async logUserMessage(content: string, agentId: string | undefined, source?: ContextSource): Promise<void> {
    await this.appendEntry('user', agentId, { content, ...(source ? { source } : {}) });
  }

  async logAssistantMessage(content: string, agentId: string | undefined, source?: ContextSource): Promise<void> {
    await this.appendEntry('assistant', agentId, { content, ...(source ? { source } : {}) });
  }

  async logThinking(content: string, agentId?: string): Promise<void> {
    await this.appendEntry('thinking', agentId, { content });
  }

  async logToolUse(toolName: string, toolInput: unknown, toolUseId: string | undefined, agentId?: string): Promise<void> {
    await this.appendEntry('tool_use', agentId, { toolName, toolInput, toolUseId });
  }

  async logToolResult(toolName: string, content: string | undefined, toolUseId: string | undefined, agentId?: string): Promise<void> {
    await this.appendEntry('tool_result', agentId, { toolName, content, toolUseId });
  }

  async logAction(action: OSAction, agentId?: string): Promise<void> {
    await this.appendEntry('action', agentId, { action });
  }

  async logInteraction(interaction: UserInteraction): Promise<void> {
    const compact = formatCompactInteraction(interaction);
    await this.appendEntry('interaction', undefined, {
      interaction: compact,
      source: 'user',
      windowId: interaction.windowId,
    });
  }

  /**
   * Persist a thread ID for a canonical agent name.
   */
  async logThreadId(canonicalAgent: string, threadId: string): Promise<void> {
    if (!this.sessionInfo.metadata.threadIds) {
      this.sessionInfo.metadata.threadIds = {};
    }
    this.sessionInfo.metadata.threadIds[canonicalAgent] = threadId;
    await this.saveMetadata();
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
