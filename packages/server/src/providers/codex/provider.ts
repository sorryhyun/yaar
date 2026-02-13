/**
 * Codex App-Server Provider.
 *
 * Uses `codex app-server` for long-running JSON-RPC communication.
 * Thin wrapper on an externally-owned AppServer (owned by WarmPool).
 *
 * Architecture:
 * - One AppServer process shared across agents (owned by WarmPool)
 * - Each agent gets its own thread (via thread/start or thread/fork)
 * - Turns are serialized through the AppServer's turn semaphore
 *   (notifications lack thread IDs, so only one turn runs at a time)
 * - Provider never stops the AppServer — WarmPool handles lifecycle
 */

import { BaseTransport } from '../base-transport.js';
import type { StreamMessage, TransportOptions, ProviderType } from '../types.js';
import type { AppServer } from './app-server.js';
import { mapNotification } from './message-mapper.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { actionEmitter } from '../../mcp/action-emitter.js';
import type { CommandExecutionRequestApprovalParams, FileChangeRequestApprovalParams } from './types.js';

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
  private currentSession: ThreadSession | null = null;

  // Interrupt signal: shared instance field so interrupt() can reach the active query.
  // Safe because the turn semaphore ensures only one query runs at a time.
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
   * No-op: AppServer is already started by WarmPool before provider creation.
   */
  async warmup(): Promise<boolean> {
    return this.appServer?.isRunning ?? false;
  }

  async isAvailable(): Promise<boolean> {
    // Check if Codex CLI is installed (use getCodexBin() for bundled exe support)
    const { getCodexBin } = await import('../../config.js');
    const cliAvailable = await this.isCliAvailable(getCodexBin());
    if (!cliAvailable) return false;

    // Check for authentication: either API key or OAuth (auth.json)
    if (process.env.OPENAI_API_KEY) {
      return true;
    }

    // Check for OAuth authentication via ~/.codex/auth.json
    try {
      const os = await import('os');
      const fs = await import('fs/promises');
      const path = await import('path');
      const authPath = path.join(os.homedir(), '.codex', 'auth.json');
      await fs.access(authPath);
      return true;
    } catch {
      return false;
    }
  }

  async *query(
    prompt: string,
    options: TransportOptions
  ): AsyncIterable<StreamMessage> {
    this.createAbortController();

    try {
      if (!this.appServer?.isRunning) {
        yield this.createErrorMessage(new Error('AppServer is not running'));
        return;
      }

      // Capture a local reference so dispose() nulling this.appServer
      // doesn't crash the finally block.
      const appServer = this.appServer;

      // Handle thread creation: new, fork, or reuse
      const threadCreated = await this.ensureThread(options);
      if (threadCreated) {
        yield { type: 'text', sessionId: this.currentSession!.threadId };
      }

      // Acquire turn lock (only one turn at a time per app-server)
      await appServer.acquireTurn();

      // Stamp monitorId so actions emitted during this turn carry the originating monitor
      if (options.monitorId) {
        actionEmitter.setCurrentMonitor(options.monitorId);
      }

      // pendingMessages is local per-query to avoid cross-talk.
      // resolveMessage uses the instance field so interrupt() can signal it.
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
        if (
          method === 'turn/completed' ||
          method === 'turn/failed' ||
          method === 'error'
        ) {
          if (this.resolveMessage) {
            this.resolveMessage(true);
            this.resolveMessage = null;
          }
        }
      };

      appServer.on('notification', notificationHandler);

      // Handle server-initiated requests (approval dialogs)
      const serverRequestHandler = (id: number, method: string, params: unknown) => {
        this.handleServerRequest(appServer, id, method, params).catch((err) => {
          console.error(`[codex] Failed to handle server request ${method}:`, err);
          appServer.respondError(id, -32000, err instanceof Error ? err.message : 'Internal error');
        });
      };
      appServer.on('server_request', serverRequestHandler);

      try {
        // Build input array with text and optional images (UserInput union from generated types)
        const input: Array<
          | { type: 'text'; text: string; text_elements: never[] }
          | { type: 'image'; url: string }
        > = [
          { type: 'text', text: prompt, text_elements: [] },
        ];

        // Add images as separate input objects (WebP from frontend capture)
        if (options.images && options.images.length > 0) {
          for (const imageDataUrl of options.images) {
            input.push({ type: 'image', url: imageDataUrl });
          }
        }

        // Start the turn and capture the turn ID for interrupt support
        const turnResult = await appServer.turnStart({
          threadId: this.currentSession!.threadId,
          input,
        });
        this.currentTurnId = turnResult.turn.id;

        // Yield messages as they arrive
        while (true) {
          if (this.isAborted()) break;

          // Check for pending messages
          while (pendingMessages.length > 0) {
            const message = pendingMessages.shift()!;
            yield message;

            // Stop yielding after complete or error
            if (message.type === 'complete' || message.type === 'error') {
              return;
            }
          }

          // Wait for the next message or turn completion
          const done = await new Promise<boolean>((resolve) => {
            this.resolveMessage = resolve;
          });

          if (done && pendingMessages.length === 0) {
            break;
          }
        }
      } finally {
        appServer.off('notification', notificationHandler);
        appServer.off('server_request', serverRequestHandler);
        actionEmitter.clearCurrentMonitor();
        this.currentTurnId = null;
        appServer.releaseTurn();
      }
    } catch (err) {
      if (this.isAbortError(err)) {
        // Expected when interrupted
        return;
      }

      // Check for session recovery error (invalid thread)
      if (
        err instanceof Error &&
        (err.message.includes('thread') || err.message.includes('invalid'))
      ) {
        // Invalidate the session and retry
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
    if (!this.appServer?.isRunning || !threadId || !turnId) return false;

    try {
      await this.appServer.turnSteer({
        threadId,
        input: [{ type: 'text', text: content }],
        expectedTurnId: turnId,
      });
      return true;
    } catch (err) {
      console.warn('[codex] turn/steer failed:', err);
      return false;
    }
  }

  interrupt(): void {
    // Send turn/interrupt to the Codex app-server to cancel the in-flight turn
    const threadId = this.currentSession?.threadId;
    const turnId = this.currentTurnId;
    if (this.appServer?.isRunning && threadId && turnId) {
      this.appServer.turnInterrupt({ threadId, turnId }).catch((err) => {
        console.warn(`[codex] turn/interrupt failed:`, err);
      });
    }

    super.interrupt();
    // Signal any pending waiters to stop
    if (this.resolveMessage) {
      this.resolveMessage(true);
      this.resolveMessage = null;
    }
  }

  /**
   * Handle a server-initiated JSON-RPC request (e.g. approval dialogs).
   * The Codex turn is paused until we respond, so no notifications arrive while waiting.
   */
  private async handleServerRequest(
    appServer: AppServer,
    id: number,
    method: string,
    params: unknown
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
          title, message, 'codex_command', p.command ?? undefined,
        );
        appServer.respond(id, {
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
          title, message, 'codex_file_change', p.grantRoot ?? undefined,
        );
        appServer.respond(id, {
          decision: approved ? 'accept' : 'decline',
        });
        break;
      }

      default:
        console.warn(`[codex] Unhandled server request: ${method}`);
        appServer.respondError(id, -32601, `Unhandled method: ${method}`);
        break;
    }
  }

  async dispose(): Promise<void> {
    await super.dispose();
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
    // Case 1: Fork from parent session
    if (options.forkSession && options.sessionId) {
      console.log(`[codex] Forking thread from parent ${options.sessionId}`);
      try {
        const result = await this.appServer!.threadFork({
          threadId: options.sessionId,
          // Override base instructions so task agents get their profile prompt
          baseInstructions: options.systemPrompt,
        });
        this.currentSession = {
          threadId: result.thread.id,
          systemPrompt: options.systemPrompt,
        };
        return true;
      } catch (err) {
        console.warn(`[codex] Fork failed, falling back to new thread:`, err);
        // Fall through to create new thread
      }
    }

    // Case 2: Resume a saved thread
    if (options.resumeThread && options.sessionId) {
      console.log(`[codex] Resuming thread ${options.sessionId}`);
      try {
        const result = await this.appServer!.threadResume({ threadId: options.sessionId });
        // Validate the resume actually loaded conversation history.
        // If turns is empty, the rollout data was likely missing (e.g. after process restart),
        // so fall through to create a fresh thread instead.
        if (result.thread.turns.length === 0) {
          console.warn(`[codex] Resumed thread has no turns, starting fresh instead`);
          // Fall through to create new thread
        } else {
          this.currentSession = {
            threadId: options.sessionId,
            systemPrompt: options.systemPrompt,
          };
          return true;
        }
      } catch (err) {
        console.warn(`[codex] Resume failed, falling back to new thread:`, err);
        // Fall through to create new thread
      }
    }

    // Case 3: Need new thread (no session or system prompt changed)
    const needsNewThread =
      !this.currentSession ||
      this.currentSession.systemPrompt !== options.systemPrompt;

    if (needsNewThread) {
      const result = await this.appServer!.threadStart({
        baseInstructions: options.systemPrompt,
      });
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
