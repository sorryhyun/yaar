/**
 * Claude Session Provider.
 *
 * Uses the Claude Agent SDK to query Claude with MCP tools.
 * Sessions are created on first real query and resumed for subsequent ones.
 */

import { query as sdkQuery, type Options as SDKOptions } from '@anthropic-ai/claude-agent-sdk';
import { BaseTransport } from '../base-transport.js';
import type { StreamMessage, TransportOptions, ProviderType } from '../types.js';
import { mapClaudeMessage } from './message-mapper.js';
import { getToolNames, getMcpToken, getActiveServers } from '../../mcp/index.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { getStorageDir, getClaudeSpawnArgs, resolveClaudeBinPath, getPort } from '../../config.js';
import { getOrchestratorPrompt as getSystemPrompt } from '../../agents/profiles/orchestrator.js';
import { type ImageMediaType, parseDataUrl } from '../../lib/image.js';

interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: ImageMediaType;
    data: string;
  };
}

interface TextContentBlock {
  type: 'text';
  text: string;
}

type ContentBlock = TextContentBlock | ImageContentBlock;

/** Max time to hold a turn's first message while MCP servers connect. */
const MCP_CONNECT_WAIT_MS = 5000;

/** Push-based async channel feeding the SDK's streaming input. */
interface InputChannel {
  push(message: unknown): void;
  close(): void;
  iterable: AsyncGenerator<unknown>;
}

function createInputChannel(): InputChannel {
  const buffer: unknown[] = [];
  let notify: (() => void) | null = null;
  let closed = false;
  async function* iterate(): AsyncGenerator<unknown> {
    for (;;) {
      while (buffer.length === 0 && !closed) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = null;
      }
      if (buffer.length === 0) return;
      yield buffer.shift();
    }
  }
  return {
    push(message) {
      buffer.push(message);
      notify?.();
    },
    close() {
      closed = true;
      notify?.();
    },
    iterable: iterate(),
  };
}

/**
 * A long-lived streaming SDK query. The spawned CLI process and its MCP
 * connections survive across turns; each turn pushes one user message into
 * the channel and reads the stream until the SDK result message.
 */
interface PersistentSession {
  stream: ReturnType<typeof sdkQuery>;
  channel: InputChannel;
  /** Prompt/tools/model identity — a change forces a reopen (with resume). */
  fingerprint: string;
  /** Resolves once every configured MCP server is connected (bounded wait). */
  mcpReady: Promise<void>;
  /** The controller bound to this stream's process. */
  abortController: AbortController;
  /** Session id this stream was opened to resume (undefined = fresh). */
  openedWithResume: string | undefined;
  /** Turns pushed so far — a virgin stream can still be swapped for a resume. */
  turnsProcessed: number;
  busy: boolean;
}

export class ClaudeSessionProvider extends BaseTransport {
  readonly name = 'claude';
  readonly providerType: ProviderType = 'claude';
  readonly systemPrompt: string;

  private sessionId: string | null = null;
  private currentQuery: ReturnType<typeof sdkQuery> | null = null;
  private persistentSession: PersistentSession | null = null;

  constructor() {
    super();
    this.systemPrompt = getSystemPrompt();
  }

  async isAvailable(): Promise<boolean> {
    return this.isCliAvailable(...getClaudeSpawnArgs());
  }

  /**
   * Get SDK options for queries.
   */
  private getSDKOptions(
    resumeSession?: string,
    systemPrompt?: string,
    agentId?: string,
    allowedTools?: string[],
  ): SDKOptions {
    const mcpHeaders: Record<string, string> = {
      Authorization: `Bearer ${getMcpToken()}`,
    };
    if (agentId) {
      mcpHeaders['X-Agent-Id'] = agentId;
    }

    // Only enable builtin tools if allowedTools includes them (or is unfiltered)
    const effectiveAllowed = allowedTools ?? getToolNames();
    const builtinTools: SDKOptions['tools'] = [];
    if (!allowedTools || allowedTools.includes('WebSearch')) {
      builtinTools.push('WebSearch');
    }

    // Build MCP server configs — only include servers needed by allowedTools.
    // This prevents the 'app' MCP server from being connected for monitor agents.
    const neededServers = new Set<string>();
    for (const tool of effectiveAllowed) {
      const m = tool.match(/^mcp__(\w+)__/);
      if (m) neededServers.add(m[1]);
    }
    const mcpServerConfigs = Object.fromEntries(
      getActiveServers()
        .filter((name) => neededServers.has(name))
        .map((name: string) => [
          name,
          {
            type: 'http' as const,
            url: `http://127.0.0.1:${getPort()}/mcp/${name}`,
            headers: mcpHeaders,
          },
        ]),
    );
    if (!allowedTools || allowedTools.includes('Task')) {
      builtinTools.push('Task');
    }

    const claudeBin = resolveClaudeBinPath();

    // When YAAR runs inside another Claude Code harness (e.g. cloud sandbox),
    // the parent leaks vars that bind the child to parent-only resources (FDs,
    // session IDs, host-managed mode). Strip them so the spawned CLI starts clean.
    const cleanEnv = { ...process.env };
    for (const k of [
      'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
      'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
      'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_REMOTE_SESSION_ID',
      'CLAUDE_CODE_CONTAINER_ID',
      'CLAUDE_CODE_REMOTE',
      'CLAUDECODE',
    ]) {
      delete cleanEnv[k];
    }

    return {
      abortController: this.createAbortController(),
      executable: 'bun',
      ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
      systemPrompt: systemPrompt ?? this.systemPrompt,
      model: 'claude-sonnet-4-6',
      resume: resumeSession,
      cwd: getStorageDir(),
      tools: builtinTools,
      allowedTools: effectiveAllowed,
      // YAAR provides no LSP integration, but the spawned `claude` CLI ships an
      // `LSP` tool by default and agents reach for it. Strip it from context so
      // they don't waste turns calling a tool that can't do anything here.
      disallowedTools: ['LSP'],
      mcpServers: mcpServerConfigs,
      includePartialMessages: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      env: {
        ...cleanEnv,
        MAX_MCP_OUTPUT_TOKENS: '131072',
        CLAUDE_CODE_DISABLE_BUILTIN_AGENTS: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
        CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1'
      },
    };
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async steer(content: string): Promise<boolean> {
    if (!this.currentQuery) return false;
    try {
      await this.currentQuery.streamInput(
        (async function* () {
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content },
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK expects SDKUserMessage but accepts partial
        })() as AsyncIterable<any>,
      );
      return true;
    } catch (err) {
      console.warn('[claude] streamInput failed:', err);
      return false;
    }
  }

  async *query(prompt: string, options: TransportOptions): AsyncIterable<StreamMessage> {
    // Determine which session to resume
    // Priority: options.sessionId > this.sessionId (warmed up)
    const resumeSession = options.sessionId ?? this.sessionId ?? undefined;
    console.log(
      `[ClaudeSessionProvider] query() - options.sessionId: ${options.sessionId}, this.sessionId: ${this.sessionId}, resumeSession: ${resumeSession}`,
    );

    const messageContent = this.buildMessageContent(prompt, options);

    yield* this.executeQuery(messageContent, resumeSession, options);
  }

  private buildMessageContent(prompt: string, options: TransportOptions): string | ContentBlock[] {
    let messageContent: string | ContentBlock[] = prompt;

    console.log(`[ClaudeSessionProvider] options.images: ${options.images?.length ?? 0} images`);
    if (options.images && options.images.length > 0) {
      console.log(
        `[ClaudeSessionProvider] First image prefix: ${options.images[0].slice(0, 50)}...`,
      );

      const contentBlocks: ContentBlock[] = [];

      for (const dataUrl of options.images) {
        const parsed = parseDataUrl(dataUrl);
        if (parsed) {
          console.log(
            `[ClaudeSessionProvider] Adding image block: ${parsed.mediaType}, data length: ${parsed.data.length}`,
          );
          contentBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: parsed.mediaType,
              data: parsed.data,
            },
          });
        } else {
          console.warn(
            `[ClaudeSessionProvider] Failed to parse data URL: ${dataUrl.slice(0, 100)}...`,
          );
        }
      }

      contentBlocks.push({
        type: 'text',
        text: prompt,
      });

      console.log(
        `[ClaudeSessionProvider] Using multimodal prompt with ${contentBlocks.length} content blocks`,
      );
      messageContent = contentBlocks;
    }

    return messageContent;
  }

  private async *executeQuery(
    messageContent: string | ContentBlock[],
    resumeSession: string | undefined,
    options: TransportOptions,
  ): AsyncIterable<StreamMessage> {
    // Stamp monitorId so actions emitted during this turn carry the correct
    // origin (mirrors Codex provider behavior).
    if (options.monitorId) {
      actionEmitter.setCurrentMonitor(options.monitorId);
    }
    try {
      if (options.forkSession && resumeSession) {
        // Forks get a dedicated one-shot process; the forked conversation goes
        // persistent from its own next turn.
        yield* this.runOneShotTurn(messageContent, resumeSession, options);
      } else {
        yield* this.runPersistentTurn(messageContent, resumeSession, options);
      }
    } finally {
      actionEmitter.clearCurrentMonitor();
    }
  }

  /** Prompt/tools/model identity of a turn — decides persistent-stream reuse. */
  private turnFingerprint(options: TransportOptions): string {
    return [
      options.systemPrompt ?? this.systemPrompt,
      (options.allowedTools ?? []).join(','),
      options.agentId ?? '',
      options.model ?? '',
    ].join(' ');
  }

  /**
   * Run one turn on the provider's long-lived streaming session, creating it
   * on first use. The CLI process and its MCP connections survive between
   * turns, so later turns skip both the spawn and the MCP handshake. A change
   * in prompt/tools/model closes the stream and reopens it with `resume`,
   * carrying the conversation over.
   */
  private async *runPersistentTurn(
    messageContent: string | ContentBlock[],
    resumeSession: string | undefined,
    options: TransportOptions,
  ): AsyncIterable<StreamMessage> {
    const fingerprint = this.turnFingerprint(options);
    const existing = this.persistentSession;
    // A turn that targets a conversation this stream doesn't carry (e.g.
    // restoring a logged thread) needs a fresh process opened with resume. A
    // virgin (prewarmed) stream carries only what it was opened to resume.
    const wrongConversation = existing
      ? existing.turnsProcessed === 0
        ? resumeSession !== existing.openedWithResume
        : options.sessionId !== undefined &&
          this.sessionId !== null &&
          options.sessionId !== this.sessionId
      : false;
    if (existing && (existing.busy || existing.fingerprint !== fingerprint || wrongConversation)) {
      await this.closePersistentSession();
    }
    if (!this.persistentSession) {
      const sdkOptions = this.getSDKOptions(
        resumeSession,
        options.systemPrompt,
        options.agentId,
        options.allowedTools,
      );
      if (options.model) {
        sdkOptions.model = options.model;
      }
      this.openPersistentSession(sdkOptions, fingerprint, resumeSession);
    }

    const session = this.persistentSession!;
    session.busy = true;
    this.currentQuery = session.stream;
    let messageCount = 0;
    try {
      await session.mcpReady;
      session.turnsProcessed++;
      session.channel.push({
        type: 'user',
        message: { role: 'user', content: messageContent },
      });

      for (;;) {
        const { value: msg, done } = await session.stream.next();
        if (done) {
          // Process exited (crash or abort) — the stream is gone.
          await this.closePersistentSession();
          if (messageCount === 0 && !session.abortController.signal.aborted) {
            console.warn(
              '[ClaudeSessionProvider] Persistent stream ended before responding; retrying fresh',
            );
            this.sessionId = null;
            yield* this.executeQuery(messageContent, undefined, options);
          }
          return;
        }
        messageCount++;
        if (session.abortController.signal.aborted) break;

        if ('session_id' in msg && msg.session_id) {
          if (!options.sessionId) {
            this.sessionId = msg.session_id;
          }
        }

        const mapped = mapClaudeMessage(msg);
        if (!mapped) continue;

        // Detect stale session error and retry without resume
        if (
          mapped.type === 'error' &&
          resumeSession &&
          mapped.error?.includes('No conversation found')
        ) {
          console.warn(
            `[ClaudeSessionProvider] Stale session ${resumeSession}, retrying without resume`,
          );
          this.sessionId = null;
          await this.closePersistentSession();
          yield* this.executeQuery(messageContent, undefined, options);
          return;
        }

        yield mapped;
        // 'complete'/'error' map the SDK result message: the turn is over but
        // the stream stays open for the next one.
        if (mapped.type === 'complete' || mapped.type === 'error') {
          console.log(`[ClaudeSessionProvider] Turn finished after ${messageCount} messages`);
          return;
        }
      }

      // Aborted mid-turn — the controller is taking the process down with it.
      await this.closePersistentSession();
    } catch (err) {
      await this.closePersistentSession();
      if (!this.isAbortError(err)) {
        yield this.createErrorMessage(err);
      }
    } finally {
      session.busy = false;
      this.currentQuery = null;
    }
  }

  private openPersistentSession(
    sdkOptions: SDKOptions,
    fingerprint: string,
    openedWithResume: string | undefined,
  ): void {
    const channel = createInputChannel();
    const stream = sdkQuery({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK expects SDKUserMessage but accepts partial
      prompt: channel.iterable as AsyncIterable<any>,
      options: sdkOptions,
    });
    this.persistentSession = {
      stream,
      channel,
      fingerprint,
      // The CLI no longer waits for HTTP MCP servers before starting a turn in
      // stream-json mode — an ungated first turn runs tool-less and the agent
      // narrates the verb calls it cannot make. Later turns resolve instantly.
      mcpReady: this.waitForMcpConnected(stream, sdkOptions),
      abortController: sdkOptions.abortController ?? new AbortController(),
      openedWithResume,
      turnsProcessed: 0,
      busy: false,
    };
  }

  /**
   * Pre-open the persistent stream with the exact options the first turn will
   * use (see AgentSession.prewarm). By the time the user sends their first
   * message, the process is up and its MCP servers are connected.
   */
  async prewarm(options: TransportOptions): Promise<void> {
    if (this.persistentSession) return;
    const resumeSession = options.sessionId ?? this.sessionId ?? undefined;
    const sdkOptions = this.getSDKOptions(
      resumeSession,
      options.systemPrompt,
      options.agentId,
      options.allowedTools,
    );
    if (options.model) {
      sdkOptions.model = options.model;
    }
    this.openPersistentSession(sdkOptions, this.turnFingerprint(options), resumeSession);
    await this.persistentSession!.mcpReady;
    console.log('[ClaudeSessionProvider] Prewarmed persistent stream (MCP connected)');
  }

  /** Tear down the long-lived stream; conversation context survives via resume. */
  private async closePersistentSession(): Promise<void> {
    const session = this.persistentSession;
    if (!session) return;
    this.persistentSession = null;
    session.channel.close();
    session.abortController.abort();
    try {
      await session.stream.return(undefined);
    } catch {
      // Teardown errors of a dying process are irrelevant.
    }
  }

  /** Dedicated single-turn process, used for session forks. */
  private async *runOneShotTurn(
    messageContent: string | ContentBlock[],
    resumeSession: string,
    options: TransportOptions,
  ): AsyncIterable<StreamMessage> {
    const sdkOptions = this.getSDKOptions(
      resumeSession,
      options.systemPrompt,
      options.agentId,
      options.allowedTools,
    );
    if (options.model) {
      sdkOptions.model = options.model;
    }
    sdkOptions.forkSession = true;

    // Hold the user message until MCP servers connect (see openPersistentSession).
    let releaseMcpGate!: () => void;
    const mcpGate = new Promise<void>((resolve) => {
      releaseMcpGate = resolve;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promptInput = (async function* (): AsyncGenerator<any> {
      await mcpGate;
      yield {
        type: 'user',
        message: { role: 'user', content: messageContent },
      };
    })();

    try {
      const stream = sdkQuery({ prompt: promptInput, options: sdkOptions });
      this.currentQuery = stream;
      void this.waitForMcpConnected(stream, sdkOptions).finally(releaseMcpGate);
      let messageCount = 0;

      for await (const msg of stream) {
        messageCount++;
        if (this.isAborted()) break;

        if ('session_id' in msg && msg.session_id) {
          if (!options.sessionId) {
            this.sessionId = msg.session_id;
          }
        }

        const mapped = mapClaudeMessage(msg);
        if (mapped) {
          // Detect stale session error and retry without resume
          if (mapped.type === 'error' && mapped.error?.includes('No conversation found')) {
            console.warn(
              `[ClaudeSessionProvider] Stale session ${resumeSession}, retrying without resume`,
            );
            this.sessionId = null;
            this.currentQuery = null;
            yield* this.executeQuery(messageContent, undefined, options);
            return;
          }
          yield mapped;
        }
      }

      console.log(`[ClaudeSessionProvider] Fork turn finished after ${messageCount} messages`);
    } catch (err) {
      if (this.isAbortError(err)) {
        return;
      }
      yield this.createErrorMessage(err);
    } finally {
      this.currentQuery = null;
    }
  }

  /**
   * Wait (bounded) until every configured MCP server reports connected
   * (~700ms for the local HTTP servers), so a turn's first message is only
   * sent once its tools exist. A failed server or timeout falls through
   * rather than stalling the turn.
   */
  private async waitForMcpConnected(
    stream: ReturnType<typeof sdkQuery>,
    sdkOptions: SDKOptions,
  ): Promise<void> {
    const expected = Object.keys(sdkOptions.mcpServers ?? {});
    if (expected.length === 0) return;
    const signal = sdkOptions.abortController?.signal;
    const deadline = Date.now() + MCP_CONNECT_WAIT_MS;
    while (Date.now() < deadline) {
      if (signal?.aborted) return;
      try {
        const statuses = await stream.mcpServerStatus();
        const byName = new Map(statuses.map((s) => [s.name, s.status]));
        if (expected.every((name) => byName.get(name) === 'connected')) return;
        // A failed server won't recover within this wait — don't burn it.
        const failed = expected.filter((name) => byName.get(name) === 'failed');
        if (failed.length > 0) {
          console.warn(
            `[ClaudeSessionProvider] MCP server(s) failed to connect: ${failed.join(', ')}`,
          );
          return;
        }
      } catch {
        // Control channel not up yet — keep polling.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.warn(
      `[ClaudeSessionProvider] MCP server(s) still pending after ${MCP_CONNECT_WAIT_MS}ms; starting turn without them`,
    );
  }

  /**
   * Interrupt the in-flight turn. On the persistent stream this is a control
   * request — the turn stops but the process and its MCP connections survive
   * for the next turn. One-shot (fork) turns abort their process.
   */
  interrupt(): void {
    const session = this.persistentSession;
    if (session?.busy) {
      void session.stream.interrupt().catch((err) => {
        console.warn('[ClaudeSessionProvider] Control interrupt failed; killing process:', err);
        void this.closePersistentSession();
      });
      return;
    }
    super.interrupt();
  }

  async dispose(): Promise<void> {
    await this.closePersistentSession();
    this.currentQuery = null;
    this.sessionId = null;
    await super.dispose();
  }
}
