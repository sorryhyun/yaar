/**
 * Codex app-server notification mapper.
 *
 * Converts JSON-RPC notifications from the app-server to StreamMessage format.
 * Uses generated types from the Codex schema for type-safe notification handling.
 */

import type { StreamMessage } from '../types.js';
import type {
  AgentMessageDeltaNotification,
  CommandExecutionOutputDeltaNotification,
  ReasoningTextDeltaNotification,
  TurnCompletedNotification,
  ErrorNotification,
  ItemStartedNotification,
  ItemCompletedNotification,
  ThreadItem,
  ThreadTokenUsageUpdatedNotification,
} from './types.js';
import { describeTurnError, notificationNotice, NOTICE_METHODS } from './errors.js';
import { toNoticeMessage } from '../notice.js';
import { formatMcpResult } from '../mcp-content.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('codex:mapper');

type CommandExecutionItem = Extract<ThreadItem, { type: 'commandExecution' }>;
type WebSearchItem = Extract<ThreadItem, { type: 'webSearch' }>;
type CollabAgentToolCallItem = Extract<ThreadItem, { type: 'collabAgentToolCall' }>;

/** Format MCP tool name with server namespace: "apps:typecheck" */
function mcpToolName(server?: string, tool?: string): string {
  if (server && tool) return `${server}:${tool}`;
  return tool ?? 'mcp_tool';
}

function mapItemStarted(p: ItemStartedNotification): StreamMessage | null {
  const item = p.item;
  switch (item?.type) {
    case 'mcpToolCall':
      return {
        type: 'tool_use',
        toolName: mcpToolName(item.server, item.tool),
        toolInput: item.arguments,
      };
    case 'commandExecution':
      return {
        type: 'tool_use',
        toolName: 'command',
        toolUseId: item.id,
        toolInput: { command: item.command },
      };
    case 'webSearch':
      return {
        type: 'tool_use',
        toolName: 'web_search',
        toolUseId: item.id,
      };
    case 'collabAgentToolCall':
      return {
        type: 'tool_use',
        toolName: `collab:${item.tool}`,
        toolUseId: item.id,
        toolInput: { prompt: item.prompt, agents: item.receiverThreadIds },
      };
    default:
      log.debug('item/started', {
        itemType: item?.type ?? 'unknown',
        itemId: item?.id ?? 'unknown',
        turnId: p.turnId ?? '?',
      });
      return null;
  }
}

function mapItemCompleted(p: ItemCompletedNotification): StreamMessage | null {
  const item = p.item;
  switch (item?.type) {
    case 'mcpToolCall':
      return {
        type: 'tool_result',
        toolName: mcpToolName(item.server, item.tool),
        content: item.error
          ? `Error: ${item.error.message}`
          : formatMcpResult({
              content: item.result?.content,
              structuredContent: item.result?.structuredContent,
              // Not in the generated result type, so read defensively — an MCP
              // result can carry its own `isError` flag distinct from `item.error`.
              isError: isErrorResult(item.result),
            }),
      };
    case 'commandExecution':
      return {
        type: 'tool_result',
        toolName: 'command',
        toolUseId: item.id,
        content: formatCommandResult(item),
      };
    case 'webSearch':
      return {
        type: 'tool_result',
        toolName: 'web_search',
        toolUseId: item.id,
        content: formatWebSearchResult(item),
      };
    case 'collabAgentToolCall':
      return {
        type: 'tool_result',
        toolName: `collab:${item.tool}`,
        toolUseId: item.id,
        content: formatCollabResult(item as CollabAgentToolCallItem),
      };
    default:
      log.debug('item/completed', {
        itemType: item?.type ?? 'unknown',
        itemId: item?.id ?? 'unknown',
        turnId: p.turnId ?? '?',
      });
      return null;
  }
}

/** Noisy codex internal events, skipped without a debug log. */
const IGNORED_PREFIXES = ['codex/event/', 'fuzzyFileSearch/'];

const IGNORED_METHODS = new Set([
  'thread/compacted',
  'account/updated',
  'account/login/completed',
  'app/list/updated',
  'turn/plan/updated',
  'turn/diff/updated',
  // Policy bookkeeping with no user-visible consequence — see `errors.ts` for
  // why these are skipped rather than surfaced as notices.
  'model/verification',
  'turn/moderationMetadata',
  'item/fileChange/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/mcpToolCall/progress',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/plan/delta',
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
  'rawResponseItem/completed',
]);

function isIgnoredNotification(method: string): boolean {
  return (
    IGNORED_PREFIXES.some((prefix) => method.startsWith(prefix)) || IGNORED_METHODS.has(method)
  );
}

/**
 * Map a JSON-RPC notification to a StreamMessage.
 * Returns null for notifications that should be skipped.
 */
export function mapNotification(method: string, params: unknown): StreamMessage | null {
  switch (method) {
    case 'turn/started':
      return null;

    case 'turn/completed': {
      const p = params as TurnCompletedNotification;
      if (p.turn?.status === 'interrupted') {
        return { type: 'error', error: 'Turn was interrupted', errorCode: 'interrupted' };
      }
      if (p.turn?.status === 'failed') {
        // The typed `codexErrorInfo` and `additionalDetails` beside `message`
        // were discarded, so a context overflow and an expired login both read
        // as whatever prose the app-server happened to attach — or, absent any,
        // as the literal string 'Turn failed'.
        const { text, code } = describeTurnError(p.turn.error, 'Turn failed');
        return { type: 'error', error: text, errorCode: code };
      }
      return { type: 'complete' };
    }

    case 'thread/tokenUsage/updated': {
      const p = params as ThreadTokenUsageUpdatedNotification;
      const t = p?.tokenUsage?.total;
      if (!t) return null;
      const cacheRead = t.cachedInputTokens ?? 0;
      const cacheWrite = t.cacheWriteInputTokens ?? 0;
      return {
        type: 'usage',
        usage: {
          // Codex counts the cache figures *inside* `inputTokens`; Claude reports
          // them beside it. Subtracting here is what makes one number mean one
          // thing downstream: on both providers `inputTokens` is the fresh
          // remainder, and the whole input a turn read is the sum of all three.
          //
          // That `cachedInputTokens` is a subset is measured — a real turn
          // reported inputTokens 17816 / cachedInputTokens 17152 / outputTokens 6
          // against totalTokens 17822, i.e. `total = input + output` with the
          // cache figure already folded in. `cacheWriteInputTokens` is assumed to
          // sit inside it the same way, which no observation can currently
          // confirm because Codex reports 0 for it on every model YAAR has seen
          // (OpenAI's caching is implicit and bills no separate write). The
          // assumption is falsifiable with one sample: if a nonzero cache write
          // ever appears alongside `totalTokens !== inputTokens + outputTokens`,
          // it is beside `inputTokens` and this subtraction must drop it.
          inputTokens: Math.max(0, (t.inputTokens ?? 0) - cacheRead - cacheWrite),
          outputTokens: t.outputTokens ?? 0,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
        },
        // `total`, not `last` — the thread's running total, re-sent several times
        // per turn. Adding these up would multiply the real figure.
        usageScope: 'session',
        ...(typeof p.tokenUsage.modelContextWindow === 'number'
          ? { contextWindow: p.tokenUsage.modelContextWindow }
          : {}),
      };
    }

    case 'item/agentMessage/delta': {
      const p = params as AgentMessageDeltaNotification;
      if (p.delta) {
        return { type: 'text', content: p.delta };
      }
      return null;
    }

    case 'item/reasoning/textDelta': {
      const p = params as ReasoningTextDeltaNotification;
      if (p.delta) {
        return { type: 'thinking', content: p.delta };
      }
      return null;
    }

    case 'item/started':
      return mapItemStarted(params as ItemStartedNotification);

    case 'item/completed':
      return mapItemCompleted(params as ItemCompletedNotification);

    case 'item/commandExecution/outputDelta': {
      // The live tail of a running command. `item/completed` for the command
      // still follows with `aggregatedOutput`, which stays the authoritative
      // result — these chunks only fill the silence while it runs, so they are
      // not fed back into context or the transcript.
      const p = params as CommandExecutionOutputDeltaNotification;
      if (!p?.delta) return null;
      return {
        type: 'tool_output_delta',
        toolName: 'command',
        toolUseId: p.itemId,
        content: p.delta,
      };
    }

    case 'error': {
      const p = params as ErrorNotification;
      const { text, code } = describeTurnError(p.error, 'Unknown error');
      // `willRetry` is the app-server telling us it is going to try again. This
      // used to map to a terminal `error` regardless, which both latched the turn
      // closed in `StreamToEventMapper` and tripped the `done` short-circuit in
      // `CodexProvider`'s read loop — so the retry's answer was produced and
      // never read. A retryable failure is a notice; only a final one is an error.
      if (p.willRetry) {
        return toNoticeMessage({ level: 'warning', code, text: `${text} Retrying.` });
      }
      return { type: 'error', error: text, errorCode: code };
    }

    default: {
      // Warnings, deprecations, model reroutes, reached limits, failed MCP
      // servers — Codex's user-facing channels, which all used to land in the
      // `console.debug` below.
      const notice = notificationNotice(method, params);
      if (notice) return toNoticeMessage(notice);
      // A notice method that produced nothing is a level signal in its quiet
      // state (`status: 'ready'`, a gauge below its limit), not an unhandled
      // event — logging it as unknown is how a handled method looks unhandled.
      if (NOTICE_METHODS.has(method)) return null;

      if (isIgnoredNotification(method)) {
        return null;
      }
      log.debug('unknown notification', { method, params });
      return null;
    }
  }
}

/** Read the MCP-level `isError` flag off a result (absent from the generated type). */
function isErrorResult(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { isError?: unknown }).isError === true
  );
}

function formatCollabResult(item: CollabAgentToolCallItem): string {
  const parts: string[] = [`tool: ${item.tool}`, `status: ${item.status}`];
  if (item.prompt) parts.push(`prompt: ${item.prompt}`);
  if (item.agentsStates) {
    const stateEntries = Object.entries(item.agentsStates)
      .map(([tid, s]) => {
        if (!s) return `${tid}: unknown`;
        const msg = s.message ? `: ${s.message}` : '';
        return `${tid}: ${s.status}${msg}`;
      })
      .join(', ');
    if (stateEntries) parts.push(`agents: ${stateEntries}`);
  }
  return parts.join('\n');
}

function formatWebSearchResult(item: WebSearchItem): string {
  const action = item.action;
  if (!action) return item.query;

  const actionDesc =
    action.type === 'search'
      ? (action.queries ?? [action.query]).filter(Boolean).join(', ')
      : action.type === 'openPage'
        ? `open: ${action.url ?? ''}`
        : action.type === 'findInPage'
          ? `find "${action.pattern ?? ''}" in ${action.url ?? ''}`
          : '';

  return actionDesc ? `${item.query} → ${actionDesc}` : item.query;
}

function formatCommandResult(item: CommandExecutionItem): string {
  const parts: string[] = [];

  if (item.command) {
    parts.push(`$ ${item.command}`);
  }

  if (item.aggregatedOutput) {
    parts.push(item.aggregatedOutput);
  }

  if (item.exitCode !== undefined && item.exitCode !== null && item.exitCode !== 0) {
    parts.push(`[exit code: ${item.exitCode}]`);
  }

  return parts.join('\n') || 'Command completed';
}
