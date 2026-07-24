/**
 * MCP `wait` tool — a bounded, abortable sleep.
 *
 * Lets an orchestrating agent (monitor / session) yield for a fixed span so a
 * slow background operation with no completion signal can make progress before
 * the agent checks its state again. Prefer a blocking call (an app command with
 * a raised `timeoutMs`, or `hook:"response"`) whenever the operation reports
 * completion directly — `wait` is for fire-and-forget work that finishes on its
 * own with nothing to await.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok } from '../../handlers/utils.js';

/** Hard cap per call. A single turn holds a monitor concurrency slot while it
 * waits, so an unbounded sleep would pin the budget indefinitely. */
export const MAX_WAIT_SECONDS = 300;

export function registerWaitTool(server: McpServer): void {
  server.registerTool(
    'wait',
    {
      description:
        'Pause for a fixed number of seconds before your next action. ' +
        'Use this to give a slow background operation time to progress — e.g. after telling an ' +
        'app to run a long job (a compile, a render, an anima generation) as fire-and-forget, ' +
        'wait, then read the app state to see whether it finished. ' +
        'Prefer a blocking call — an app command with a raised timeoutMs, or a window message ' +
        'with hook:"response" — when the operation reports completion directly; only use wait for ' +
        `work that finishes on its own with no completion signal to await. Capped at ${MAX_WAIT_SECONDS}s per call.`,
      inputSchema: {
        seconds: z
          .number()
          .describe(
            `How many seconds to wait (0–${MAX_WAIT_SECONDS}). Values outside this range are clamped.`,
          ),
        reason: z
          .string()
          .optional()
          .describe('Optional note on what you are waiting for (shown in logs).'),
      },
    },
    async (args, extra) => {
      const requested = Number.isFinite(args.seconds) ? args.seconds : 0;
      const seconds = Math.min(Math.max(requested, 0), MAX_WAIT_SECONDS);
      const signal = extra?.signal;

      if (signal?.aborted) {
        return ok('Wait skipped — the turn was already cancelled.');
      }

      const start = Date.now();
      const interrupted = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve(false);
        }, seconds * 1000);
        const onAbort = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (interrupted) {
        return ok(`Wait interrupted after ~${elapsed}s.`);
      }
      const clampNote =
        requested !== seconds ? ` (requested ${requested}s, clamped to ${seconds}s)` : '';
      return ok(`Waited ${seconds}s${clampNote}.`);
    },
  );
}
