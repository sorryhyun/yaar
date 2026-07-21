/**
 * Codex App-Server Provider (WebSocket transport).
 *
 * Uses `codex app-server` for long-running JSON-RPC communication.
 * Each provider gets its own WebSocket connection via `appServer.createConnection()`,
 * enabling true parallel execution — no turn serialization mutex needed.
 *
 * Architecture:
 * - One AppServer process shared across agents (owned by WarmPool)
 * - Each provider has its own WS connection (notifications routed per-connection)
 * - Each agent gets its own thread (via thread/start or thread/fork)
 * - Provider never stops the AppServer — WarmPool handles lifecycle
 */

import { BaseTransport } from '../base-transport.js';
import type { StreamMessage, TransportOptions, ProviderType } from '../types.js';
import type { AppServer } from './app-server.js';
import type { JsonRpcWsClient } from './jsonrpc-ws-client.js';
import { mapNotification } from './message-mapper.js';
import { ORCHESTRATOR_PROMPT as SYSTEM_PROMPT } from '../../agents/profiles/orchestrator.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { buildMcpServerSet } from '../mcp-servers.js';
import type {
  ThreadStartParams,
  ThreadStartResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadForkParams,
  ThreadForkResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  CommandExecutionRequestApprovalParams,
  FileChangeRequestApprovalParams,
} from './types.js';

/**
 * Session state for a thread.
 */
interface ThreadSession {
  threadId: string;
  systemPrompt: string;
  /** Model this thread was started with (undefined = app-server default). */
  model?: string;
  /** Sorted MCP namespaces this thread was scoped to (undefined = unrestricted). */
  mcpScope?: string;
}

/** Per-thread MCP server override map: namespace → server config. */
type McpServerOverride = Record<
  string,
  { url: string; bearer_token_env_var: string; http_headers?: Record<string, string> }
>;

export class CodexProvider extends BaseTransport {
  readonly name = 'codex';
  readonly providerType: ProviderType = 'codex';
  readonly systemPrompt = SYSTEM_PROMPT;

  private appServer: AppServer | null;
  private client: JsonRpcWsClient | null = null;
  private currentSession: ThreadSession | null = null;

  // Interrupt signal: shared instance field so interrupt() can reach the active query.
  private resolveMessage: ((done: boolean) => void) | null = null;

  // Current in-flight turn ID for interrupt/steer support
  private currentTurnId: string | null = null;

  // Resolves when currentTurnId is set — allows steer() to wait for turn start
  private turnReadyResolve: (() => void) | null = null;
  private turnReadyPromise: Promise<void> | null = null;

  /**
   * Create a CodexProvider.
   * @param appServer - The shared AppServer (owned by WarmPool, not this provider).
   */
  constructor(appServer: AppServer) {
    super();
    this.appServer = appServer;
  }

  /**
   * Get the underlying AppServer (for sharing with other providers).
   */
  getAppServer(): AppServer | null {
    return this.appServer;
  }

  /**
   * Get the current thread/session ID.
   */
  getSessionId(): string | null {
    return this.currentSession?.threadId ?? null;
  }

  /**
   * Establish a dedicated WebSocket connection to the app-server.
   * Called by WarmPool during provider creation.
   */
  async warmup(): Promise<boolean> {
    if (!this.appServer?.isRunning) return false;

    try {
      this.client = await this.appServer.createConnection();
      return true;
    } catch (err) {
      console.error('[codex] Failed to establish WS connection during warmup:', err);
      return false;
    }
  }

  async isAvailable(): Promise<boolean> {
    return (this.appServer?.isRunning ?? false) && (this.client?.isConnected ?? false);
  }

  async *query(prompt: string, options: TransportOptions): AsyncIterable<StreamMessage> {
    this.createAbortController();

    try {
      if (!this.appServer?.isRunning || !this.client?.isConnected) {
        yield this.createErrorMessage(new Error('AppServer or WS connection is not available'));
        return;
      }

      // Capture local references so dispose() doesn't crash the finally block.
      const client = this.client;

      // Handle thread creation: new, fork, or reuse
      const threadCreated = await this.ensureThread(options);
      if (threadCreated) {
        yield { type: 'text', sessionId: this.currentSession!.threadId };
      }

      // Stamp monitorId so actions emitted during this turn carry the correct origin
      // when the MCP boundary can't resolve one from the agent (see resolveMonitorId).
      // Agent identity needs no such fallback: buildMcpScope bakes this agent's token
      // into the thread's MCP header, so every tool call self-identifies.
      if (options.monitorId) {
        actionEmitter.setCurrentMonitor(options.monitorId);
      }

      // pendingMessages is local per-query to avoid cross-talk.
      const pendingMessages: StreamMessage[] = [];
      this.resolveMessage = null;

      const notificationHandler = (method: string, params: unknown) => {
        const message = mapNotification(method, params);
        if (message) {
          pendingMessages.push(message);
          if (this.resolveMessage) {
            this.resolveMessage(false);
            this.resolveMessage = null;
          }
        }

        // Check for turn completion
        if (method === 'turn/completed' || method === 'turn/failed' || method === 'error') {
          if (this.resolveMessage) {
            this.resolveMessage(true);
            this.resolveMessage = null;
          }
        }
      };

      client.on('notification', notificationHandler);

      // Handle server-initiated requests (approval dialogs)
      const serverRequestHandler = (id: number, method: string, params: unknown) => {
        this.handleServerRequest(client, id, method, params).catch((err) => {
          console.error(`[codex] Failed to handle server request ${method}:`, err);
          client.respondError(id, -32000, err instanceof Error ? err.message : 'Internal error');
        });
      };
      client.on('server_request', serverRequestHandler);

      try {
        // Build input array with text and optional images
        const input: Array<
          { type: 'text'; text: string; text_elements: never[] } | { type: 'image'; url: string }
        > = [{ type: 'text', text: prompt, text_elements: [] }];

        if (options.images && options.images.length > 0) {
          for (const imageDataUrl of options.images) {
            input.push({ type: 'image', url: imageDataUrl });
          }
        }

        // Prepare turn-ready promise so steer() can wait for the turn to start
        this.turnReadyPromise = new Promise<void>((resolve) => {
          this.turnReadyResolve = resolve;
        });

        // Start the turn and capture the turn ID for interrupt/steer support
        const turnResult = await client.request<TurnStartParams, TurnStartResponse>('turn/start', {
          threadId: this.currentSession!.threadId,
          input,
        });
        this.currentTurnId = turnResult.turn.id;
        this.turnReadyResolve?.();
        this.turnReadyResolve = null;

        // Yield messages as they arrive
        while (true) {
          if (this.isAborted()) break;

          while (pendingMessages.length > 0) {
            const message = pendingMessages.shift()!;
            yield message;

            if (message.type === 'complete' || message.type === 'error') {
              return;
            }
          }

          const done = await new Promise<boolean>((resolve) => {
            this.resolveMessage = resolve;
          });

          if (done && pendingMessages.length === 0) {
            break;
          }
        }
      } finally {
        client.off('notification', notificationHandler);
        client.off('server_request', serverRequestHandler);
        actionEmitter.clearCurrentMonitor();
        this.currentTurnId = null;
        this.turnReadyResolve?.();
        this.turnReadyResolve = null;
        this.turnReadyPromise = null;
      }
    } catch (err) {
      if (this.isAbortError(err)) {
        return;
      }

      // Check for session recovery error (invalid thread)
      if (
        err instanceof Error &&
        (err.message.includes('thread') || err.message.includes('invalid'))
      ) {
        this.currentSession = null;
        yield* this.query(prompt, options);
        return;
      }

      yield this.createErrorMessage(err);
    }
  }

  async steer(content: string): Promise<boolean> {
    if (!this.client?.isConnected || !this.currentSession?.threadId) return false;

    // Wait for the turn to start (resolves the timing race between
    // running=true and currentTurnId being set after turn/start RPC)
    if (!this.currentTurnId && this.turnReadyPromise) {
      await Promise.race([
        this.turnReadyPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
      ]);
    }

    const turnId = this.currentTurnId;
    if (!turnId) return false;

    try {
      await this.client.request<TurnSteerParams, TurnSteerResponse>('turn/steer', {
        threadId: this.currentSession.threadId,
        input: [{ type: 'text', text: content, text_elements: [] }],
        expectedTurnId: turnId,
      });
      return true;
    } catch (err) {
      console.warn('[codex] turn/steer failed:', err);
      return false;
    }
  }

  interrupt(): void {
    const threadId = this.currentSession?.threadId;
    const turnId = this.currentTurnId;
    if (this.client?.isConnected && threadId && turnId) {
      this.client
        .request<TurnInterruptParams, TurnInterruptResponse>('turn/interrupt', {
          threadId,
          turnId,
        })
        .catch((err) => {
          console.warn(`[codex] turn/interrupt failed:`, err);
        });
    }

    super.interrupt();
    if (this.resolveMessage) {
      this.resolveMessage(true);
      this.resolveMessage = null;
    }
  }

  /**
   * Handle a server-initiated JSON-RPC request (e.g. approval dialogs).
   */
  private async handleServerRequest(
    client: JsonRpcWsClient,
    id: number,
    method: string,
    params: unknown,
  ): Promise<void> {
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const p = params as CommandExecutionRequestApprovalParams;
        const description = p.command ?? 'unknown command';
        const title = 'Command Execution';
        const message = p.reason
          ? `${p.reason}\n\n\`${description}\``
          : `Codex wants to run:\n\n\`${description}\``;

        const approved = await actionEmitter.showPermissionDialog(
          title,
          message,
          'codex_command',
          p.command ?? undefined,
        );
        client.respond(id, {
          decision: approved ? 'accept' : 'decline',
        });
        break;
      }

      case 'item/fileChange/requestApproval': {
        const p = params as FileChangeRequestApprovalParams;
        const title = 'File Change';
        const message = p.reason
          ? p.reason
          : `Codex wants to modify files${p.grantRoot ? ` under ${p.grantRoot}` : ''}`;

        const approved = await actionEmitter.showPermissionDialog(
          title,
          message,
          'codex_file_change',
          p.grantRoot ?? undefined,
        );
        client.respond(id, {
          decision: approved ? 'accept' : 'decline',
        });
        break;
      }

      default:
        console.warn(`[codex] Unhandled server request: ${method}`);
        client.respondError(id, -32601, `Unhandled method: ${method}`);
        break;
    }
  }

  async dispose(): Promise<void> {
    await super.dispose();
    // Close own WS connection
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    // Don't stop the AppServer — it's owned by WarmPool.
    this.appServer = null;
    this.currentSession = null;
    this.currentTurnId = null;
    this.resolveMessage = null;
    this.turnReadyResolve?.();
    this.turnReadyResolve = null;
    this.turnReadyPromise = null;
  }

  /**
   * Ensure the thread is set up based on transport options.
   * Handles three cases: fork from parent, start new, or reuse existing.
   * Returns true if a new thread was created (caller should yield sessionId).
   */
  /**
   * Build a per-thread `mcp_servers` override that pins the caller's identity onto
   * every YAAR MCP server as an `x-agent-token` HTTP header — a credential minted for
   * this agent alone, which the server maps back to its id (mcp/agent-tokens.ts) to
   * resolve session/monitor/window/role context.
   *
   * This used to send the agent *id* itself, which the server took at face value. All
   * Codex agents share one app-server process and one bearer token — which lives in
   * that process's environment as YAAR_MCP_TOKEN — so a model with shell access could
   * read the token, set the header to the session agent's id, and be the session
   * agent. A token it cannot mint or guess closes that.
   *
   * Why this is required for Codex: all agents share one app-server process and
   * one HTTP MCP server, so a tool call arriving over HTTP carries no inherent
   * agent identity. Without the header the server cannot tell overlapping turns
   * apart — e.g. a monitor agent spawns an app agent (fire-and-forget), and the
   * app agent resolves the wrong/empty window, so its `app:command`/`app:query`
   * fail with "no active window context". Stamping identity per-thread means every
   * tool call self-identifies, eliminating the race at its root.
   *
   * We expose the FULL active server set (system+verbs+app) — same as the
   * process-level config — so this override never narrows the agent's tools; the
   * only thing it adds over the process-level set is the header.
   *
   * Returns null when there is no agentId to attach, so the thread falls back to
   * the process-level server set (and the legacy global fallback).
   */
  private buildMcpScope(agentId?: string): {
    servers: McpServerOverride;
    signature: string;
  } | null {
    if (!agentId) return null;

    // No filter: expose the FULL active server set, same as the process-level config.
    const { servers: endpoints, agentToken } = buildMcpServerSet(agentId);
    const servers: McpServerOverride = {};
    for (const { name, url } of endpoints) {
      servers[name] = {
        url,
        bearer_token_env_var: 'YAAR_MCP_TOKEN',
        http_headers: { 'x-agent-token': agentToken! },
      };
    }
    // agentId is stable for a given provider instance, so this signature is
    // constant across that agent's turns → no needless thread churn. Including
    // it still forces a fresh thread if the provider is ever rebound to another
    // agent, keeping the header correct.
    const namespaces = endpoints.map(({ name }) => name);
    return { servers, signature: `${agentId}:${[...namespaces].sort().join(',')}` };
  }

  private async ensureThread(options: TransportOptions): Promise<boolean> {
    const client = this.client!;

    // Stamp the agent's identity onto the thread's MCP servers so its tool calls
    // self-identify to the shared MCP server (see buildMcpScope).
    const scope = this.buildMcpScope(options.agentId);
    const mcpConfig = scope ? { mcp_servers: scope.servers } : undefined;
    const mcpScope = scope?.signature;

    // Case 1: Fork from parent session
    if (options.forkSession && options.sessionId) {
      console.log(`[codex] Forking thread from parent ${options.sessionId}`);
      try {
        const fullParams: ThreadForkParams = {
          threadId: options.sessionId,
          baseInstructions: options.systemPrompt,
          ...(options.model ? { model: options.model } : {}),
          ...(mcpConfig ? { config: mcpConfig } : {}),
        };
        const result = await client.request<ThreadForkParams, ThreadForkResponse>(
          'thread/fork',
          fullParams,
        );
        this.currentSession = {
          threadId: result.thread.id,
          systemPrompt: options.systemPrompt,
          model: options.model,
          mcpScope,
        };
        return true;
      } catch (err) {
        console.warn(`[codex] Fork failed, falling back to new thread:`, err);
      }
    }

    // Case 2: Resume a saved thread
    if (options.resumeThread && options.sessionId) {
      console.log(`[codex] Resuming thread ${options.sessionId}`);
      try {
        const fullParams: ThreadResumeParams = {
          threadId: options.sessionId,
        };
        const result = await client.request<ThreadResumeParams, ThreadResumeResponse>(
          'thread/resume',
          fullParams,
        );
        if (result.thread.turns.length === 0) {
          console.warn(`[codex] Resumed thread has no turns, starting fresh instead`);
        } else {
          this.currentSession = {
            threadId: options.sessionId,
            systemPrompt: options.systemPrompt,
            model: options.model,
            mcpScope,
          };
          return true;
        }
      } catch (err) {
        console.warn(`[codex] Resume failed, falling back to new thread:`, err);
      }
    }

    // Case 3: Need new thread (no session, system prompt, model, or MCP scope changed)
    const needsNewThread =
      !this.currentSession ||
      this.currentSession.systemPrompt !== options.systemPrompt ||
      this.currentSession.model !== options.model ||
      this.currentSession.mcpScope !== mcpScope;

    if (needsNewThread) {
      const fullParams: ThreadStartParams = {
        experimentalRawEvents: false,
        baseInstructions: options.systemPrompt,
        ...(options.model ? { model: options.model } : {}),
        ...(mcpConfig ? { config: mcpConfig } : {}),
      };
      const result = await client.request<ThreadStartParams, ThreadStartResponse>(
        'thread/start',
        fullParams,
      );
      this.currentSession = {
        threadId: result.thread.id,
        systemPrompt: options.systemPrompt,
        model: options.model,
        mcpScope,
      };
      return true;
    }

    // Case 4: Reuse existing thread (same system prompt + model + MCP scope, continuing)
    return false;
  }
}
