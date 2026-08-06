/**
 * Shared helpers for agent turn orchestration.
 *
 * Extracts common patterns from MonitorTaskProcessor and AppTaskProcessor:
 * - Reload context assembly (windowSnapshot -> fingerprint -> reloadPrefix)
 * - Agent turn lifecycle (role setup -> MESSAGE_ACCEPTED -> handleMessage -> record actions -> cleanup)
 * - Budget output callback creation
 */

import { ServerEventType } from '@yaar/shared';
import type { WindowState, OSAction } from '@yaar/shared';
import type { ContextSource } from './context.js';
import type { MonitorBudgetPolicy } from './context-pool-policies/index.js';
import type { TurnContext, Task } from './pool-types.js';
import type { PooledAgent } from './agent-roster.js';
import type { Fingerprint } from '../reload/types.js';

// ── Reload context ──────────────────────────────────────────────────────────

export interface PreparedReloadContext {
  windowSnapshot: WindowState[];
  openWindowsContext: string;
  fp: Fingerprint;
  reloadPrefix: string;
}

export function buildReloadContext(
  ctx: TurnContext,
  task: Task,
  options?: { currentWindowId?: string; monitorId?: string },
): PreparedReloadContext {
  // Scoped to the monitor the turn runs on: `<open_windows monitor="1">` that lists
  // monitor 0's windows is a lie the agent acts on. `task.monitorId` only says who sent
  // the task, so a caller that has resolved the owning monitor passes it explicitly.
  const monitorId = options?.monitorId ?? task.monitorId;
  // Stack order, not listing order: `formatOpenWindows` reads the array position as the z
  // rank. The fingerprint below is unaffected — `computeWindowStateHash` sorts its input,
  // so a reordered snapshot hashes the same and no cache entry is invalidated by a click.
  const windowSnapshot = ctx.windowState.stackOrder(monitorId);
  const openWindowsContext = ctx.contextAssembly.formatOpenWindows(windowSnapshot, {
    monitorId,
    currentWindowId: options?.currentWindowId,
    getRawWindowId: (handle) => ctx.windowState.handleMap.getRawWindowId(handle),
    focusedWindowId: ctx.windowState.getFocusedWindowId(),
  });
  const fp = ctx.reloadPolicy.buildFingerprint(task, windowSnapshot);
  const reloadPrefix = ctx.reloadPolicy.formatReloadOptions(ctx.reloadPolicy.findMatches(fp, 3));
  return { windowSnapshot, openWindowsContext, fp, reloadPrefix };
}

// ── Agent turn lifecycle ────────────────────────────────────────────────────

export interface AgentTurnOptions {
  agent: PooledAgent;
  role: string;
  source: ContextSource;
  task: Task;
  prompt: string;
  fp?: Fingerprint;
  windowId?: string;
  canonicalAgent?: string;
  resumeSessionId?: string;
  monitorId?: string;
  allowedTools?: string[];
  /** Override the provider's base system prompt (used by window agents with profile prompts) */
  systemPromptOverride?: string;
  /** Override the model for this turn (e.g. from app.json agentType) */
  model?: string;
  onBeforeRun?: () => Promise<void> | void;
  onAfterRun?: (recordedActions: OSAction[]) => Promise<void> | void;
  onFinally?: () => Promise<void> | void;
  /** Called with the assistant's response text when the turn completes. */
  onAssistantResponse?: (responseText: string) => void;
}

/**
 * Run a single agent turn with standard lifecycle:
 * 1. Set role + lastUsed
 * 2. Emit MESSAGE_ACCEPTED
 * 3. onBeforeRun()
 * 4. handleMessage (with auto context-tape recording)
 * 5. Record actions to reload cache
 * 6. onAfterRun(actions)
 * 7. finally: clear role, onFinally()
 */
export async function runAgentTurn(ctx: TurnContext, opts: AgentTurnOptions): Promise<OSAction[]> {
  const { agent, role, source, task, prompt, fp } = opts;

  agent.currentRole = role;
  agent.lastUsed = Date.now();

  await ctx.sendEvent({
    type: ServerEventType.MESSAGE_ACCEPTED,
    messageId: task.messageId,
    agentId: role,
  });

  await opts.onBeforeRun?.();

  try {
    await agent.session.handleMessage(prompt, {
      role,
      source,
      interactions: task.interactions,
      messageId: task.messageId,
      monitorId: opts.monitorId,
      canonicalAgent: opts.canonicalAgent,
      resumeSessionId: opts.resumeSessionId,
      allowedTools: opts.allowedTools,
      systemPromptOverride: opts.systemPromptOverride,
      model: opts.model,
      windowId: opts.windowId,
      onContextMessage: (msgRole, content) => {
        if (msgRole === 'assistant') {
          ctx.contextAssembly.appendAssistantMessage(ctx.contextTape, content, source);
          opts.onAssistantResponse?.(content);
        }
      },
    });

    const recordedActions = agent.session.getRecordedActions();
    if (fp) ctx.reloadPolicy.maybeRecord(task, fp, recordedActions, opts.windowId);

    await opts.onAfterRun?.(recordedActions);

    return recordedActions;
  } finally {
    agent.currentRole = null;
    await opts.onFinally?.();
  }
}

// ── Budget output callback ──────────────────────────────────────────────────

export function createBudgetOutputCallback(
  ctx: { budgetPolicy: MonitorBudgetPolicy },
  agent: PooledAgent,
  monitorId: string,
  label = 'agent',
): (bytes: number) => void {
  return (bytes) => {
    ctx.budgetPolicy.recordOutput(monitorId, bytes);
    if (!ctx.budgetPolicy.checkOutputBudget(monitorId)) {
      console.warn(
        `[ContextPool] Monitor ${monitorId} exceeded output budget — interrupting ${label}`,
      );
      agent.session.interrupt().catch((err) => {
        console.error(`[ContextPool] Failed to interrupt ${label} for ${monitorId}:`, err);
      });
    }
  };
}
