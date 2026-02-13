/**
 * Abstract base class for AI transports.
 *
 * Provides shared functionality for all transport implementations:
 * - Abort controller management
 * - Error message creation
 * - Common interface implementation
 */

import type { AITransport, StreamMessage, TransportOptions, ProviderType } from './types.js';

export abstract class BaseTransport implements AITransport {
  abstract readonly name: string;
  abstract readonly providerType: ProviderType;
  abstract readonly systemPrompt: string;

  protected abortController?: AbortController;

  /**
   * Check if this transport is available.
   * Subclasses must implement this to check for required dependencies.
   */
  abstract isAvailable(): Promise<boolean>;

  /**
   * Execute a query and yield streaming messages.
   * Subclasses must implement this to communicate with their AI provider.
   */
  abstract query(prompt: string, options: TransportOptions): AsyncIterable<StreamMessage>;

  /**
   * Create a new AbortController for a query.
   * Should be called at the start of each query.
   */
  protected createAbortController(): AbortController {
    this.abortController = new AbortController();
    return this.abortController;
  }

  /**
   * Check if the current query has been aborted.
   */
  protected isAborted(): boolean {
    return this.abortController?.signal.aborted ?? false;
  }

  /**
   * Interrupt the current query by aborting the controller.
   */
  interrupt(): void {
    this.abortController?.abort();
  }

  /**
   * Create an error StreamMessage.
   */
  protected createErrorMessage(error: unknown): StreamMessage {
    return {
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  /**
   * Check if an error is an abort error (expected when interrupted).
   */
  protected isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }

  /**
   * Clean up resources.
   * Default implementation interrupts any ongoing query.
   * Subclasses can override to add additional cleanup.
   */
  async dispose(): Promise<void> {
    this.interrupt();
  }

  /**
   * Helper to check if a CLI tool is available.
   * Useful for transports that depend on external CLI tools.
   */
  protected async isCliAvailable(command: string): Promise<boolean> {
    try {
      const { execSync } = await import('child_process');
      execSync(`"${command}" --version`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}
