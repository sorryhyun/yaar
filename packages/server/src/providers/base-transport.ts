/**
 * Abstract base class for AI transports.
 *
 * Provides shared functionality for all transport implementations:
 * - Abort controller management
 * - Error message creation
 * - Common interface implementation
 */

import type { AITransport, StreamMessage, TransportOptions, ProviderType } from './types.js';
import { errMessage } from '../lib/errors.js';

/**
 * Successful CLI probes, keyed by command line. A binary that answered
 * `--version` once cannot vanish mid-process, so the probe runs once per boot.
 * Holds the in-flight promise so concurrent callers share a single spawn.
 * Failures are deliberately not cached: a missing binary fails fast (ENOENT)
 * and is cheap to re-probe, while the slow failure — a timeout under load — is
 * exactly the one that deserves a retry rather than a permanent verdict.
 */
const cliProbes = new Map<string, Promise<boolean>>();

/** Spawn `cmd --version` without blocking the event loop. */
async function probeCli(cmd: string, args: string[]): Promise<boolean> {
  const { execFile } = await import('child_process');
  return new Promise<boolean>((resolve) => {
    execFile(cmd, [...args, '--version'], { timeout: 10_000 }, (err) => resolve(!err));
  });
}

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
      error: errMessage(error),
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
   *
   * The probe must never be synchronous: the MCP servers it gates are HTTP
   * endpoints served by this same process, so blocking here stalls the very
   * server the spawned CLI is about to connect to.
   *
   * @param spawnArgs - The command and any prefix args (e.g. from getClaudeSpawnArgs()).
   *                    '--version' is appended automatically.
   */
  protected async isCliAvailable(...spawnArgs: string[]): Promise<boolean> {
    const [cmd, ...args] = spawnArgs;
    if (!cmd) return false;

    const key = spawnArgs.join('\0');
    const cached = cliProbes.get(key);
    if (cached) return cached;

    const probe = probeCli(cmd, args);
    cliProbes.set(key, probe);
    if (!(await probe)) {
      cliProbes.delete(key);
      return false;
    }
    return true;
  }
}
