/**
 * Codex App-Server Transport.
 *
 * Uses `codex app-server` for long-running JSON-RPC communication.
 * This provides:
 * - System prompts via baseInstructions in thread/start
 * - Session persistence via thread IDs
 * - Streaming via JSON-RPC notifications
 */

import { BaseTransport } from '../base-transport.js';
import type { StreamMessage, TransportOptions, ProviderType } from '../types.js';
import { AppServer, type AppServerConfig } from './app-server.js';
import { mapNotification } from './message-mapper.js';

/**
 * Session state for a thread.
 */
interface ThreadSession {
  threadId: string;
  systemPrompt: string;
}

export class CodexTransport extends BaseTransport {
  readonly name = 'codex';
  readonly providerType: ProviderType = 'codex';

  private appServer: AppServer | null = null;
  private currentSession: ThreadSession | null = null;
  private pendingMessages: StreamMessage[] = [];
  private resolveMessage: ((done: boolean) => void) | null = null;

  async isAvailable(): Promise<boolean> {
    // Check if Codex CLI is installed
    const cliAvailable = await this.isCliAvailable('codex');
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
      // Ensure app-server is running
      await this.ensureAppServer(options.model);

      // Check if we need a new thread (system prompt changed or no session)
      const needsNewThread =
        !this.currentSession ||
        this.currentSession.systemPrompt !== options.systemPrompt;

      if (needsNewThread) {
        // Start a new thread with the system prompt
        const result = await this.appServer!.threadStart({
          baseInstructions: options.systemPrompt,
        });

        this.currentSession = {
          threadId: result.threadId,
          systemPrompt: options.systemPrompt,
        };

        // Emit the session ID
        yield { type: 'text', sessionId: this.currentSession.threadId };
      }

      // Set up notification handling
      this.pendingMessages = [];
      this.resolveMessage = null;

      const notificationHandler = (method: string, params: unknown) => {
        const message = mapNotification(method, params);
        if (message) {
          this.pendingMessages.push(message);
          // Signal that a message is available
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

      this.appServer!.on('notification', notificationHandler);

      try {
        // Start the turn
        await this.appServer!.turnStart({
          threadId: this.currentSession!.threadId,
          input: [{ type: 'text', text: prompt }],
        });

        // Yield messages as they arrive
        while (true) {
          if (this.isAborted()) break;

          // Check for pending messages
          while (this.pendingMessages.length > 0) {
            const message = this.pendingMessages.shift()!;
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

          if (done && this.pendingMessages.length === 0) {
            break;
          }
        }
      } finally {
        this.appServer!.off('notification', notificationHandler);
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

  interrupt(): void {
    super.interrupt();
    // Signal any pending waiters to stop
    if (this.resolveMessage) {
      this.resolveMessage(true);
      this.resolveMessage = null;
    }
  }

  async dispose(): Promise<void> {
    await super.dispose();

    if (this.appServer) {
      await this.appServer.stop();
      this.appServer = null;
    }

    this.currentSession = null;
    this.pendingMessages = [];
    this.resolveMessage = null;
  }

  /**
   * Ensure the app-server is running.
   */
  private async ensureAppServer(model?: string): Promise<void> {
    if (this.appServer?.isRunning) {
      return;
    }

    const config: AppServerConfig = {};
    if (model) {
      config.model = model;
    }

    this.appServer = new AppServer(config);

    // Handle errors
    this.appServer.on('error', (err) => {
      console.error('[codex] App-server error:', err);
    });

    // Handle restarts
    this.appServer.on('restart', (attempt) => {
      console.log(`[codex] App-server restarting (attempt ${attempt})`);
      // Invalidate session on restart
      this.currentSession = null;
    });

    await this.appServer.start();
  }
}
