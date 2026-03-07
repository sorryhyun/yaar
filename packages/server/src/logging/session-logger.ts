import { mkdir, appendFile } from 'fs/promises';
import { join } from 'path';
import type { OSAction, UserInteraction } from '@yaar/shared';
import { formatCompactInteraction } from '@yaar/shared';
import { SESSIONS_DIR, ensureSessionsDir } from './index.js';
import type { AgentInfo, SessionInfo, SessionMetadata } from './types.js';
import type { ContextSource } from '../agents/context.js';

const LOG_FLUSH_MS = 200;
const METADATA_FLUSH_MS = 300;

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
export async function createSession(provider: string, verbMode?: boolean): Promise<SessionInfo> {
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
    verbMode,
    agents: {
      'main-0': {
        agentId: 'main-0',
        parentAgentId: null,
        createdAt: now,
      },
    },
  };

  await Bun.write(join(directory, 'metadata.json'), JSON.stringify(metadata, null, 2));

  // Create main messages log
  await Bun.write(join(directory, 'messages.jsonl'), '');

  // Create default agent JSONL log
  await Bun.write(join(directory, 'agents', 'default.jsonl'), '');

  return { sessionId, directory, metadata };
}

/**
 * Session logger for recording session activity.
 */
export class SessionLogger {
  private sessionInfo: SessionInfo;

  // Write buffer: accumulates JSONL lines per file, flushed on a debounced timer
  private writeBuffer = new Map<string, string[]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private metadataTimer: ReturnType<typeof setTimeout> | null = null;
  private metadataDirty = false;

  constructor(sessionInfo: SessionInfo) {
    this.sessionInfo = sessionInfo;
  }

  /**
   * Register a new agent in the session hierarchy.
   */
  async registerAgent(
    agentId: string,
    parentAgentId: string | null,
    windowId?: string,
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
    await Bun.write(join(this.sessionInfo.directory, 'agents', `${agentFilename}.jsonl`), '');

    // Update metadata (debounced)
    this.scheduleMetadataSave();
  }

  /**
   * Append a structured entry to both global and per-agent logs.
   * Buffered — actual writes happen on debounced flush.
   */
  private appendEntry(
    type: string,
    agentId: string | undefined,
    fields: Record<string, unknown>,
  ): void {
    const agent = agentId ?? 'main-0';
    const parentAgentId = this.sessionInfo.metadata.agents[agent]?.parentAgentId ?? null;
    const entry = {
      type,
      timestamp: new Date().toISOString(),
      agentId: agent,
      parentAgentId,
      ...fields,
    };

    const line = JSON.stringify(entry) + '\n';

    // Buffer global messages log
    const globalPath = join(this.sessionInfo.directory, 'messages.jsonl');
    this.bufferLine(globalPath, line);

    // Buffer per-agent JSONL
    const agentFilename = agent.replace(/[^a-zA-Z0-9-_]/g, '_');
    const agentPath = join(this.sessionInfo.directory, 'agents', `${agentFilename}.jsonl`);
    this.bufferLine(agentPath, line);

    this.scheduleFlush();
  }

  private bufferLine(filePath: string, line: string): void {
    let lines = this.writeBuffer.get(filePath);
    if (!lines) {
      lines = [];
      this.writeBuffer.set(filePath, lines);
    }
    lines.push(line);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((err) => {
        console.error('[SessionLogger] Flush failed:', err);
      });
    }, LOG_FLUSH_MS);
  }

  /**
   * Flush all buffered log lines to disk.
   */
  async flush(): Promise<void> {
    if (this.writeBuffer.size === 0 && !this.metadataDirty) return;

    // Snapshot and clear the buffer
    const entries = [...this.writeBuffer.entries()];
    this.writeBuffer.clear();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Write each file's accumulated lines in a single appendFile call
    const writes = entries.map(([filePath, lines]) =>
      appendFile(filePath, lines.join('')).catch(() => {
        // Agent file might not exist yet
      }),
    );
    await Promise.all(writes);

    // Also flush metadata if dirty
    if (this.metadataDirty) {
      this.metadataDirty = false;
      if (this.metadataTimer) {
        clearTimeout(this.metadataTimer);
        this.metadataTimer = null;
      }
      await this.saveMetadataToDisk();
    }
  }

  /**
   * Flush all pending writes and clean up timers. Call on session cleanup.
   */
  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.metadataTimer) {
      clearTimeout(this.metadataTimer);
      this.metadataTimer = null;
    }
    this.metadataDirty = true; // force metadata write
    await this.flush();
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

  logUserMessage(content: string, agentId: string | undefined, source?: ContextSource): void {
    this.appendEntry('user', agentId, { content, ...(source ? { source } : {}) });
  }

  logAssistantMessage(content: string, agentId: string | undefined, source?: ContextSource): void {
    this.appendEntry('assistant', agentId, { content, ...(source ? { source } : {}) });
  }

  logThinking(content: string, agentId?: string): void {
    this.appendEntry('thinking', agentId, { content });
  }

  logToolUse(
    toolName: string,
    toolInput: unknown,
    toolUseId: string | undefined,
    agentId?: string,
  ): void {
    this.appendEntry('tool_use', agentId, { toolName, toolInput, toolUseId });
  }

  logToolResult(
    toolName: string,
    content: string | undefined,
    toolUseId: string | undefined,
    agentId?: string,
    meta?: {
      isError?: boolean;
      errorCategory?: string;
      durationMs?: number;
    },
  ): void {
    this.appendEntry('tool_result', agentId, { toolName, content, toolUseId, ...meta });
  }

  logAction(action: OSAction, agentId?: string): void {
    this.appendEntry('action', agentId, { action });
  }

  logInteraction(interaction: UserInteraction): void {
    const compact = formatCompactInteraction(interaction);
    this.appendEntry('interaction', undefined, {
      interaction: compact,
      source: 'user',
      windowId: interaction.windowId,
    });
  }

  /**
   * Persist a thread ID for a canonical agent name.
   */
  logThreadId(canonicalAgent: string, threadId: string): void {
    if (!this.sessionInfo.metadata.threadIds) {
      this.sessionInfo.metadata.threadIds = {};
    }
    this.sessionInfo.metadata.threadIds[canonicalAgent] = threadId;
    this.scheduleMetadataSave();
  }

  /**
   * Update the last activity timestamp. Also forces a flush.
   */
  async updateLastActivity(): Promise<void> {
    this.sessionInfo.metadata.lastActivity = new Date().toISOString();
    this.metadataDirty = true;
    await this.flush();
  }

  /**
   * Schedule a debounced metadata save.
   */
  private scheduleMetadataSave(): void {
    this.metadataDirty = true;
    if (this.metadataTimer) return;
    this.metadataTimer = setTimeout(() => {
      this.metadataTimer = null;
      this.metadataDirty = false;
      this.saveMetadataToDisk().catch((err) => {
        console.error('[SessionLogger] Metadata save failed:', err);
      });
    }, METADATA_FLUSH_MS);
  }

  /**
   * Write metadata to disk immediately.
   */
  private async saveMetadataToDisk(): Promise<void> {
    await Bun.write(
      join(this.sessionInfo.directory, 'metadata.json'),
      JSON.stringify(this.sessionInfo.metadata, null, 2),
    );
  }
}
