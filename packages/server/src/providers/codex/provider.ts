/**
 * Codex App-Server Provider.
 *
 * Uses `codex app-server` for long-running JSON-RPC communication.
 * Supports shared AppServer instances with thread forking for parallel agents.
 *
 * Architecture:
 * - One AppServer process per connection (shared across agents)
 * - Each agent gets its own thread (via thread/start or thread/fork)
 * - Turns are serialized through the AppServer's turn semaphore
 *   (notifications lack thread IDs, so only one turn runs at a time)
 */

import { BaseTransport } from '../base-transport.js';
import type { StreamMessage, TransportOptions, ProviderType } from '../types.js';
import { AppServer, type AppServerConfig } from './app-server.js';
import { mapNotification } from './message-mapper.js';
import { SYSTEM_PROMPT } from './system-prompt.js';

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

  private appServer: AppServer | null = null;
  private ownsAppServer = false; // true if this provider created the AppServer
  private currentSession: ThreadSession | null = null;

  // Interrupt signal: shared instance field so interrupt() can reach the active query.
  // Safe because the turn semaphore ensures only one query runs at a time.
  private resolveMessage: ((done: boolean) => void) | null = null;

  /**
   * Create a CodexProvider.
   * @param sharedAppServer - Optional shared AppServer to use instead of creating a new one.
   */
  constructor(sharedAppServer?: AppServer) {
    super();
    if (sharedAppServer) {
      this.appServer = sharedAppServer;
      this.appServer.retain();
      this.ownsAppServer = false;
    }
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
   * Eagerly start the AppServer so it's ready for the first query
   * and can be shared with other providers.
   */
  async warmup(): Promise<boolean> {
    try {
      await this.ensureAppServer();
      return true;
    } catch (err) {
      console.error('[codex] Warmup failed:', err);
      return false;
    }
  }

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

      // Handle thread creation: new, fork, or reuse
      const threadCreated = await this.ensureThread(options);
      if (threadCreated) {
        yield { type: 'text', sessionId: this.currentSession!.threadId };
      }

      // Acquire turn lock (only one turn at a time per app-server)
      await this.appServer!.acquireTurn();

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

      this.appServer!.on('notification', notificationHandler);

      try {
        // Build input array with text and optional images
        const input: Array<{ type: 'text'; text: string } | { type: 'image'; url: string }> = [
          { type: 'text', text: prompt },
        ];

        // Add images as separate ImageInput objects
        if (options.images && options.images.length > 0) {
          for (const imageDataUrl of options.images) {
            input.push({ type: 'image', url: imageDataUrl });
          }
        }

        // Start the turn
        await this.appServer!.turnStart({
          threadId: this.currentSession!.threadId,
          input,
        });

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
        this.appServer!.off('notification', notificationHandler);
        this.appServer!.releaseTurn();
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
      if (this.ownsAppServer) {
        // Only stop the process if we created it and no one else is using it
        if (this.appServer.release()) {
          await this.appServer.stop();
        }
      } else {
        this.appServer.release();
      }
      this.appServer = null;
    }

    this.currentSession = null;
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

    // Case 2: Need new thread (no session or system prompt changed)
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

    // Case 3: Reuse existing thread (same system prompt, continuing conversation)
    return false;
  }

  /**
   * Ensure the app-server is running.
   */
  private async ensureAppServer(model?: string): Promise<void> {
    if (this.appServer?.isRunning) {
      return;
    }

    const config: AppServerConfig = {
      model: model ?? 'gpt-5.3-codex',
    };

    this.appServer = new AppServer(config);
    this.appServer.retain();
    this.ownsAppServer = true;

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
