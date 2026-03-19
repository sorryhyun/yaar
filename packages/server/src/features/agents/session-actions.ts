/**
 * Session agent action execution logic.
 *
 * Handles audit, coordinate, and query actions by delegating to the session agent.
 */

import type { ContextPool } from '../../agents/context-pool.js';
import { SESSION_AGENT_PROFILE } from '../../agents/profiles/index.js';

export type SessionAction = 'audit' | 'coordinate' | 'query';

export interface SessionActionPayload {
  plan?: string;
  question?: string;
}

export interface SessionActionResult {
  success: boolean;
  error?: string;
}

/**
 * Execute a session agent action (audit, coordinate, or query).
 *
 * Gets or creates the session agent from the pool, builds the appropriate prompt,
 * and runs it through the agent. Returns plain data, not VerbResult.
 */
export async function executeSessionAction(
  pool: ContextPool,
  action: SessionAction,
  payload: SessionActionPayload,
): Promise<SessionActionResult> {
  const agent = await pool.getOrCreateSessionAgent();
  if (!agent)
    return { success: false, error: 'Failed to create session agent — agent limit reached.' };

  // Build prompt based on action type
  let prompt: string;
  if (action === 'audit') {
    prompt =
      'Audit the current session. Read all monitor states, check for anomalies (stuck agents, excessive queues, conflicts), and report findings.';
  } else if (action === 'coordinate') {
    if (typeof payload.plan !== 'string' || !payload.plan)
      return { success: false, error: '"plan" (string) is required for coordinate action.' };
    prompt = `Coordinate the following cross-monitor workflow:\n\n${payload.plan}`;
  } else {
    if (typeof payload.question !== 'string' || !payload.question)
      return { success: false, error: '"question" (string) is required for query action.' };
    prompt = payload.question;
  }

  const role = `session-${action}-${Date.now()}`;
  agent.currentRole = role;
  agent.lastUsed = Date.now();

  try {
    await agent.session.handleMessage(prompt, {
      role,
      source: `yaar://monitors/0`, // Session agent is monitor-less; use monitor-0 for routing
      messageId: role,
      allowedTools: SESSION_AGENT_PROFILE.allowedTools,
      systemPromptOverride: SESSION_AGENT_PROFILE.systemPrompt,
    });
  } finally {
    agent.currentRole = null;
  }

  return { success: true };
}
