import { mkdir, appendFile } from 'fs/promises';
import { join } from 'path';
import type { OSAction, UserInteraction } from '@yaar/shared';
import { formatCompactInteraction } from '../lib/format-interaction.js';
import { SESSIONS_DIR, ensureSessionsDir } from './index.js';
import type { AgentInfo, SessionInfo, SessionMetadata } from './types.js';
import type { ContextSource } from '../agents/context.js';
import type { EscapeGuardRecord } from '../providers/types.js';
import { createLogger } from '../observability/log.js';
import { offloadContent, writeBlobs, type BlobRef } from './blobs.js';

const log = createLogger('SessionLogger');

const LOG_FLUSH_MS = 200;
const METADATA_FLUSH_MS = 300;

/**
 * Revive JSON that has been stringified into a string field so it lands in the
 * log as real JSON instead of an escaped blob. A string that parses to an object
 * or array is replaced by the parsed value; everything else (plain text, numbers,
 * quoted primitives) is left untouched. Walks objects/arrays recursively so
 * nested stringified payloads (e.g. a tool input's `content`) are revived too.
 */
export function reviveJson(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const looksLikeJson =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'));
    if (looksLikeJson) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        // Not valid JSON — keep the original string.
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(reviveJson);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = reviveJson(v);
    }
    return out;
  }
  return value;
}

/**
 * Serialize a value that came from outside the logger. A verb result is whatever a
 * handler returned, so it can carry a cycle or a BigInt — neither of which is worth
 * losing the entry over, let alone throwing out of a logging call.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    // `JSON.stringify` yields undefined for a bare function or undefined — fall back
    // rather than handing a non-string to a signature that promises one.
    return (
      JSON.stringify(value, (_key, v) => {
        if (typeof v === 'bigint') return `${v}n`;
        if (v && typeof v === 'object') {
          if (seen.has(v as object)) return '[Circular]';
          seen.add(v as object);
        }
        return v;
      }) ?? String(value)
    );
  } catch {
    return String(value);
  }
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
 *
 * `dir` defaults to the real `session_logs/` — a parameter so a test can mint one into a
 * temp directory of its own instead of the one every suite in the process shares.
 */
export async function createSession(
  provider: string,
  dir: string = SESSIONS_DIR,
): Promise<SessionInfo> {
  if (dir === SESSIONS_DIR) await ensureSessionsDir();

  const sessionId = generateSessionId();
  const directory = join(dir, sessionId);

  await mkdir(directory, { recursive: true });
  await mkdir(join(directory, 'agents'), { recursive: true });

  const now = new Date().toISOString();
  const metadata: SessionMetadata = {
    createdAt: now,
    provider,
    lastActivity: now,
    pid: process.pid,
    agents: {
      'monitor-0': {
        agentId: 'monitor-0',
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

  // Blobs awaiting write (sha256 → bytes), and the hashes already stored this session.
  // `knownBlobs` is what makes a re-read of the same resource cost a set lookup instead
  // of a filesystem round trip — see logging/blobs.ts.
  private pendingBlobs = new Map<string, string>();
  private knownBlobs = new Set<string>();

  constructor(sessionInfo: SessionInfo) {
    this.sessionInfo = sessionInfo;
  }

  /**
   * Get the session ID for this logger.
   */
  getSessionId(): string {
    return this.sessionInfo.sessionId;
  }

  /**
   * Update the provider name in session metadata (e.g., from 'pending' to 'claude').
   */
  updateProvider(provider: string): void {
    this.sessionInfo.metadata.provider = provider;
    this.scheduleMetadataSave();
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
    const agent = agentId ?? null;
    const parentAgentId = agent
      ? (this.sessionInfo.metadata.agents[agent]?.parentAgentId ?? null)
      : null;
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

    // Buffer per-agent JSONL (skip for agent-less entries like user interactions)
    if (agent) {
      const agentFilename = agent.replace(/[^a-zA-Z0-9-_]/g, '_');
      const agentPath = join(this.sessionInfo.directory, 'agents', `${agentFilename}.jsonl`);
      this.bufferLine(agentPath, line);
    }

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
        log.error('flush failed', { err });
      });
    }, LOG_FLUSH_MS);
  }

  /**
   * Flush all buffered log lines to disk.
   */
  async flush(): Promise<void> {
    if (this.writeBuffer.size === 0 && this.pendingBlobs.size === 0 && !this.metadataDirty) return;

    // Snapshot and clear the buffer
    const entries = [...this.writeBuffer.entries()];
    this.writeBuffer.clear();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Blobs first, lines second. A line carrying a `contentRef` is a promise that the
    // bytes are resolvable; writing it before its blob would make a reader tailing the
    // log — or a crash landing between the two writes — see a reference to nothing.
    // The reverse order only ever leaves an unreferenced blob, which is inert.
    if (this.pendingBlobs.size > 0) {
      const blobs = new Map(this.pendingBlobs);
      this.pendingBlobs.clear();
      try {
        await writeBlobs(this.sessionInfo.directory, blobs, this.knownBlobs);
      } catch (err) {
        log.error('blob write failed', { err, count: blobs.size });
      }
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
    toolInputEscapes?: { unicodeEscapes: number; literalBackslashU: number },
  ): void {
    this.appendEntry('tool_use', agentId, {
      toolName,
      toolInput: reviveJson(toolInput),
      toolUseId,
      ...(toolInputEscapes ? { toolInputEscapes } : {}),
    });
  }

  /**
   * Render a result payload for the log: inline when small, a `contentRef` when not.
   *
   * Offloading is decided on the *raw* string and stores it verbatim, before
   * `reviveJson` gets a chance to reshape it. The blob is meant to be the bytes the
   * call actually returned — a replay reading a prettied-up parse of them is reading
   * something the session never saw.
   */
  private resolveContent(content: string | undefined): {
    content?: unknown;
    contentRef?: BlobRef;
  } {
    if (content === undefined) return {};

    const offloaded = offloadContent(content);
    if (!offloaded) return { content: reviveJson(content) };

    // Already stored (a re-read of the same resource) or already queued this flush —
    // either way the bytes are accounted for and only the reference needs logging.
    if (!this.knownBlobs.has(offloaded.ref.sha256)) {
      this.pendingBlobs.set(offloaded.ref.sha256, offloaded.bytes);
    }
    return { contentRef: offloaded.ref };
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
    if (meta?.isError) {
      this.sessionInfo.metadata.failureCount = (this.sessionInfo.metadata.failureCount ?? 0) + 1;
      this.scheduleMetadataSave();
    }
    this.appendEntry('tool_result', agentId, {
      toolName,
      ...this.resolveContent(content),
      toolUseId,
      ...meta,
    });
  }

  /**
   * Record what an iframe verb call returned.
   *
   * The counterpart to the `logToolUse` that `POST /api/verb` writes before dispatch.
   * Without it the log holds the intent of every app-initiated call and the outcome of
   * none — and on a busy session those calls are the overwhelming majority of entries,
   * so the transcript describes what was asked for and never what came back.
   *
   * Kept as its own method rather than folded into `logToolResult` because there is no
   * `toolUseId` to pair on: the verb route logs the call and the result back to back,
   * and the pairing is positional.
   */
  logVerbResult(
    toolName: string,
    result: unknown,
    meta?: { isError?: boolean; durationMs?: number },
  ): void {
    if (meta?.isError) {
      this.sessionInfo.metadata.failureCount = (this.sessionInfo.metadata.failureCount ?? 0) + 1;
      this.scheduleMetadataSave();
    }
    const serialized = typeof result === 'string' ? result : safeStringify(result);
    this.appendEntry('verb_result', undefined, {
      toolName,
      ...this.resolveContent(serialized),
      ...meta,
    });
  }

  /**
   * Record an escape guard firing, with the text that triggered it.
   *
   * Its own entry type rather than a field on `tool_use`: the tripwire cancels
   * the call, so there is no `tool_use` entry to hang it on and the firing would
   * otherwise leave no trace in the log at all.
   */
  logEscapeGuard(escapeGuard: EscapeGuardRecord, agentId?: string): void {
    this.appendEntry('escape_guard', agentId, {
      toolName: escapeGuard.toolName,
      escapeGuard,
    });
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
        log.error('metadata save failed', { err });
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
