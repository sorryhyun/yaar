/**
 * TaskDispatcher — dispatches tasks to specialized (forked) agents.
 *
 * Extracted from ContextPool to separate task dispatch orchestration concerns.
 */

import type { OSAction } from '@yaar/shared';
import type { PoolContext } from './pool-context.js';
import { getProfile } from './profiles.js';

export interface DispatchResult {
  status: 'completed' | 'failed' | 'interrupted';
  summary: string;
  actions: { type: string; windowId?: string; title?: string }[];
  error?: string;
}

export class TaskDispatcher {
  constructor(private readonly ctx: PoolContext) {}

  /**
   * Dispatch a task to a specialized agent.
   * The task agent forks the main agent's Claude session (inheriting full conversation context)
   * and runs with a profile-specific tool subset and system prompt.
   */
  async dispatchTask(options: {
    objective?: string;
    profile?: string;
    hint?: string;
    monitorId?: string;
    messageId?: string;
  }): Promise<DispatchResult> {
    const monitorId = options.monitorId ?? 'monitor-0';
    const profile = getProfile(options.profile ?? 'default');

    // 1. Get main agent's session ID for forking
    const mainAgent = this.ctx.agentPool.getMainAgent(monitorId);
    const parentSessionId = mainAgent?.session.getRawSessionId() ?? undefined;

    // 2. Create task agent
    const taskAgent = await this.ctx.agentPool.createTaskAgent();
    if (!taskAgent) {
      return {
        status: 'failed',
        summary: '',
        actions: [],
        error: 'Agent limit reached — cannot create task agent.',
      };
    }

    const taskRole = `task-${options.messageId ?? Date.now()}-${Date.now()}`;
    taskAgent.currentRole = taskRole;

    // 3. Build prompt (minimal — fork carries context)
    const prompt = options.objective ?? 'Execute the user request.';

    // 4. Run with fork
    try {
      await taskAgent.session.handleMessage(prompt, {
        role: taskRole,
        source: 'main',
        forkSession: !!parentSessionId,
        parentSessionId,
        systemPromptOverride: profile.systemPrompt,
        allowedTools: profile.allowedTools,
        monitorId,
      });

      const actions = taskAgent.session.getRecordedActions();
      const summary = this.formatActionSummary(actions);
      this.ctx.timeline.pushAI(taskRole, options.hint ?? 'task', actions);

      return {
        status: 'completed',
        summary,
        actions: actions.map((a) => this.summarizeAction(a)),
      };
    } catch (err) {
      return {
        status: 'failed',
        summary: '',
        actions: [],
        error: String(err),
      };
    } finally {
      taskAgent.currentRole = null;
      await this.ctx.agentPool.disposeTaskAgent(taskAgent);
    }
  }

  private formatActionSummary(actions: OSAction[]): string {
    if (actions.length === 0) return 'No actions taken.';
    return (
      actions
        .map((a) => {
          switch (a.type) {
            case 'window.create':
              return `Created window "${a.windowId}"`;
            case 'window.close':
              return `Closed window "${a.windowId}"`;
            case 'window.setContent':
              return `Updated window "${a.windowId}"`;
            case 'window.setTitle':
              return `Set title of "${a.windowId}"`;
            case 'notification.show':
              return `Showed notification "${a.title}"`;
            default:
              return `Action: ${a.type}`;
          }
        })
        .join('. ') + '.'
    );
  }

  private summarizeAction(action: OSAction): { type: string; windowId?: string; title?: string } {
    const result: { type: string; windowId?: string; title?: string } = { type: action.type };
    if ('windowId' in action) result.windowId = action.windowId;
    if ('title' in action && typeof action.title === 'string') result.title = action.title;
    return result;
  }
}
