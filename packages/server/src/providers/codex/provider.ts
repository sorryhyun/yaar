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
import { SYSTEM_PROMPT } from './system-prompt.js';
import { actionEmitter } from '../../mcp/action-emitter.js';
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
}

export class CodexProvider extends BaseTransport {
  readonly name = 'codex';
  readonly providerType: ProviderType = 'codex';
  readonly systemPrompt = SYSTEM_PROMPT;

  private appServer: AppServer | null;
  private client: JsonRpcWsClient | null = null;
  private currentSession: ThreadSession | null = null;

  // Interrupt signal: shared instance field so interrupt() can reach the active query.
  private resolveMessage: ((done: boolean) => void) | null = null;

  // Current in-flight turn ID for interrupt support
  private currentTurnId: string | null = null;

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

      // Stamp monitorId so actions emitted during this turn carry the originating monitor
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

        // Start the turn and capture the turn ID for interrupt support
        const turnResult = await client.request<TurnStartParams, TurnStartResponse>('turn/start', {
          threadId: this.currentSession!.threadId,
          input,
        });
        this.currentTurnId = turnResult.turn.id;

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
    const threadId = this.currentSession?.threadId;
    const turnId = this.currentTurnId;
    if (!this.client?.isConnected || !threadId || !turnId) return false;

    try {
      await this.client.request<TurnSteerParams, TurnSteerResponse>('turn/steer', {
        threadId,
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
  }

  /**
   * Ensure the thread is set up based on transport options.
   * Handles three cases: fork from parent, start new, or reuse existing.
   * Returns true if a new thread was created (caller should yield sessionId).
   */
  private async ensureThread(options: TransportOptions): Promise<boolean> {
    const client = this.client!;

    // Case 1: Fork from parent session
    if (options.forkSession && options.sessionId) {
      console.log(`[codex] Forking thread from parent ${options.sessionId}`);
      try {
        const fullParams: ThreadForkParams = {
          persistExtendedHistory: false,
          threadId: options.sessionId,
          baseInstructions: options.systemPrompt,
        };
        const result = await client.request<ThreadForkParams, ThreadForkResponse>(
          'thread/fork',
          fullParams,
        );
        this.currentSession = {
          threadId: result.thread.id,
          systemPrompt: options.systemPrompt,
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
          persistExtendedHistory: false,
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
          };
          return true;
        }
      } catch (err) {
        console.warn(`[codex] Resume failed, falling back to new thread:`, err);
      }
    }

    // Case 3: Need new thread (no session or system prompt changed)
    const needsNewThread =
      !this.currentSession || this.currentSession.systemPrompt !== options.systemPrompt;

    if (needsNewThread) {
      const fullParams: ThreadStartParams = {
        experimentalRawEvents: false,
        persistExtendedHistory: false,
        baseInstructions: options.systemPrompt,
      };
      const result = await client.request<ThreadStartParams, ThreadStartResponse>(
        'thread/start',
        fullParams,
      );
      this.currentSession = {
        threadId: result.thread.id,
        systemPrompt: options.systemPrompt,
      };
      return true;
    }

    // Case 4: Reuse existing thread (same system prompt, continuing conversation)
    return false;
  }
}
