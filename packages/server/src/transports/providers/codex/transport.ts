/**
 * Codex SDK Transport.
 *
 * Uses the @openai/codex-sdk to communicate with OpenAI's Codex agent.
 * Requires the Codex CLI to be installed and OPENAI_API_KEY to be set.
 */

import { Codex, type Thread, type ThreadOptions } from '@openai/codex-sdk';
import { BaseTransport } from '../../base-transport.js';
import type { StreamMessage, TransportOptions, ProviderType } from '../../types.js';
import { mapCodexEvent } from './message-mapper.js';

export class CodexTransport extends BaseTransport {
  readonly name = 'codex';
  readonly providerType: ProviderType = 'codex';

  private codex: Codex | null = null;
  private thread: Thread | null = null;
  private threadOptions: ThreadOptions = {};

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
      // Initialize Codex instance if needed
      if (!this.codex) {
        this.codex = new Codex();
      }

      // Set thread options including model
      this.threadOptions = {
        model: options.model ?? 'gpt-5.2',
      };

      // Resume or start thread
      if (options.sessionId && !this.thread) {
        try {
          this.thread = this.codex.resumeThread(options.sessionId, this.threadOptions);
        } catch {
          // Thread not found, start a new one
          this.thread = this.codex.startThread(this.threadOptions);
        }
      } else if (!this.thread) {
        this.thread = this.codex.startThread(this.threadOptions);
      }

      // Run the query with streaming
      const { events } = await this.thread.runStreamed(prompt);

      for await (const event of events) {
        if (this.isAborted()) break;

        const mapped = mapCodexEvent(event);
        if (mapped) yield mapped;
      }
    } catch (err) {
      if (this.isAbortError(err)) {
        // Expected when interrupted
        return;
      }
      yield this.createErrorMessage(err);
    }
  }

  interrupt(): void {
    super.interrupt();
    // Codex SDK doesn't have a direct abort mechanism,
    // but the async generator will stop iterating when aborted
  }

  async dispose(): Promise<void> {
    await super.dispose();
    this.thread = null;
    this.codex = null;
  }
}
