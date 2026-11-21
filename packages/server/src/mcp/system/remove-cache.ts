/**
 * `remove_cache` — the agent-facing half of self cache management
 * (`ENABLE_SELF_CACHE_MANAGEMENT=1`). The mechanism, and why a removal only lands on the
 * next turn, is `providers/claude/self-cache.ts`; this file is the tool's wording.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getAgentId } from '../../agents/agent-context.js';
import { ok } from '../../lib/verb-result.js';
import { formatTokens } from '../../providers/claude/context-items.js';
import { planRemoval, type IndexedItem } from '../../providers/claude/self-cache.js';
import { strictInput } from '../strict-input.js';
import { REMOVE_CACHE_TOOL } from './tool-names.js';

/** How the CLI names the `tool_use` block a call came from. */
const TOOL_USE_ID_META = 'claudecode/toolUseId';

const LIST_LIMIT = 30;
const MAX_INDICES = 50;

function formatItems(items: IndexedItem[]): string {
  return items
    .map(
      ({ index, item }) =>
        `  ${String(index).padStart(3)}  ${item.kind.padEnd(14)}  ${formatTokens(item.tokens).padEnd(13)}  ${item.label}`,
    )
    .join('\n');
}

export function registerSelfCacheTools(server: McpServer): void {
  server.registerTool(
    REMOVE_CACHE_TOOL,
    {
      description:
        'Drop earlier tool results, or your own earlier messages, from your context to keep a ' +
        'long conversation lean. Items are addressed by position counting back from this call: ' +
        '-1 is the most recent tool result or message before it, -2 the one before that. This ' +
        "tool's own calls and results are not counted, and neither is anything in the message " +
        'you call it from — the result of a call made alongside this one is not addressable ' +
        'yet. Call with no indices to list recent items with their sizes.\n\n' +
        'A removal takes effect at the start of your next turn — the rest of this turn still ' +
        'sees everything — and leaves a one-line marker where the item was. Everything after ' +
        'the earliest removed item is then re-read at full price instead of from cache, so use ' +
        'this on a large item you no longer need, soon after it arrives; do not use it to tidy ' +
        'small or old items.',
      inputSchema: strictInput({
        indices: z
          .array(z.number().int().negative())
          .max(MAX_INDICES)
          .optional()
          .describe('Positions to remove, e.g. [-1] or [-1, -3]. Omit to list.'),
      }),
    },
    async (args, ctx) => {
      const agentId = getAgentId();
      if (!agentId) return ok(`${REMOVE_CACHE_TOOL} is not available: no agent context.`);

      const toolUseId = ctx.mcpReq._meta?.[TOOL_USE_ID_META];
      const plan = await planRemoval(
        agentId,
        args.indices ?? [],
        typeof toolUseId === 'string' ? toolUseId : undefined,
      );
      if (!plan.ok) return ok(`${REMOVE_CACHE_TOOL} is not available: ${plan.reason}.`);

      const parts: string[] = [];
      if (plan.scheduled.length > 0) {
        const tokens = plan.scheduled.reduce((sum, { item }) => sum + item.tokens, 0);
        parts.push(
          `Scheduled for removal at the start of your next turn (${formatTokens(tokens)}):\n` +
            formatItems(plan.scheduled),
        );
      }
      if (plan.missing.length > 0) {
        parts.push(
          `Nothing at ${plan.missing.join(', ')} — ${plan.items.length} item(s) are addressable. ` +
            'Results of calls made in the same message as this one are not addressable until a later step.',
        );
      }
      if (plan.scheduled.length === 0) {
        parts.push(
          plan.items.length > 0
            ? `Recent items, newest first:\n${formatItems(plan.items.slice(0, LIST_LIMIT))}`
            : 'Nothing removable in context yet.',
        );
        if (plan.pendingCount > 0) {
          parts.push(`${plan.pendingCount} item(s) already scheduled for removal.`);
        }
      }
      return ok(parts.join('\n\n'));
    },
  );
}
