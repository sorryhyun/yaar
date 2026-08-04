/**
 * MCP tools for sub-agents — one channel, N names.
 *
 * This is the only MCP namespace in YAAR whose tool list depends on *who is
 * connecting*. Every other server registers the same tools for every agent; this one
 * reads the calling sub-agent's record and registers exactly the tools its owning app
 * declared at spawn. That asymmetry is safe for one structural reason: whatever the
 * names are, every tool here does the same single thing —
 *
 *     dispatch `persona:{toolName}` to the owning app's own iframe, and return the reply
 *
 * — over the same request/response bridge the app agent's `command` tool already uses.
 * The names and descriptions are prompt material (see `agents/profiles/sub-agent.ts`);
 * the reach is fixed here, in code, and is a strict subset of the app agent's, which
 * can dispatch *any* command to that iframe rather than a declared few.
 *
 * ## How the tool list gets here
 *
 * `createServerForName` runs inside `runWithAgentContext`, so by the time this is
 * called the agent token has already been resolved to an agent id. The id resolves to
 * a sub-agent record in the pool, and the record carries the tools. A caller that is
 * not a sub-agent — or is one that was spawned with no tools — registers nothing at
 * all: the namespace exists for them, and is empty. (They also never reach it:
 * `buildSDKOptions` connects only the MCP servers named in the turn's tool allowlist,
 * and a tool-less sub-agent's allowlist is empty.)
 *
 * The list is fixed for the life of the sub-agent, which is what makes a per-MCP-session
 * registration correct: a re-`spawn` of a live sub-agent is documented to hand back the
 * one that exists rather than recast it, so its tools cannot change under an open
 * session.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { handleAppCommand } from '../../features/window/app-protocol.js';
import { personaCommandFor } from '../../features/apps/persona-commands.js';
import { getAgentId } from '../../agents/agent-context.js';
import { getActiveSession, error } from '../../handlers/utils.js';
import type { VerbResult } from '../../handlers/uri-registry.js';
import type { LiveSession } from '../../session/live-session.js';
import type { SubAgent } from '../../agents/agent-pool.js';
import type { SubAgentToolParam, SubAgentToolSpec } from '../../agents/profiles/sub-agent.js';

/**
 * The sub-agent this MCP request is coming from, or null for anyone else.
 *
 * Resolved from the agent id the *token* proved, never from anything the caller says:
 * a sub-agent cannot name another sub-agent's record any more than it can name
 * another app's window.
 */
function callingSubAgent(): SubAgent | null {
  const agentId = getAgentId();
  if (!agentId) return null;
  try {
    return getActiveSession().getPool()?.agentPool.findSubAgentForAgent(agentId) ?? null;
  } catch {
    // No active session (the hub is empty) — there is no pool to ask, and a
    // tool-less namespace is the right answer rather than a thrown initialize.
    return null;
  }
}

/** Build the Zod shape one app-defined tool's `input` declares. */
function inputShape(input?: Record<string, SubAgentToolParam>): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, spec] of Object.entries(input ?? {})) {
    let field: z.ZodTypeAny;
    switch (spec.type) {
      case 'number':
        field = z.number();
        break;
      case 'boolean':
        field = z.boolean();
        break;
      case 'object':
        field = z.record(z.string(), z.unknown());
        break;
      case 'array':
        field = z.array(z.unknown());
        break;
      default:
        field = z.string();
    }
    if (spec.description) field = field.describe(spec.description);
    shape[name] = spec.optional ? field.optional() : field;
  }
  return shape;
}

/**
 * Which window a tool call lands in: an open window of the sub-agent's own app, on the
 * sub-agent's own monitor.
 *
 * Never launches one. The app agent's cross-app path auto-opens a window because an
 * agent was asked to drive an app that happens to be closed; here, "no window" means
 * the app whose characters these are is not on screen, and opening it as a side effect
 * of a character deciding to remember something is not a thing the user asked for.
 */
function resolveOwnWindow(session: LiveSession, record: SubAgent): string | undefined {
  const fromPool = session.getPool()?.getActiveAppWindow(record.monitorId, record.appId);
  if (fromPool) return fromPool;
  return session.windowState
    .listWindows()
    .find(
      (w) =>
        w.appId === record.appId &&
        session.windowState.getMonitorForWindow(w.id) === record.monitorId,
    )?.id;
}

/**
 * Run one app-defined tool call: bridge it to the owning app's iframe and hand back
 * whatever the app answered.
 *
 * Exported for the tests that drive the round trip without an MCP client in the way.
 */
export async function dispatchSubAgentTool(
  record: SubAgent,
  toolName: string,
  args: Record<string, unknown>,
): Promise<VerbResult> {
  // The session and the window resolve together or not at all: a hub with no session
  // and an app with no window are the same answer to the caller.
  const target = ((): { session: LiveSession; windowId: string } | null => {
    try {
      const session = getActiveSession();
      const windowId = resolveOwnWindow(session, record);
      return windowId ? { session, windowId } : null;
    } catch {
      return null;
    }
  })();

  if (!target) {
    // An error *result*, not a throw: the turn continues and the model can say
    // something instead of dying because a window closed mid-sentence.
    return error(
      `no open "${record.appId}" window on monitor ${record.monitorId} to receive "${toolName}".`,
    );
  }

  return handleAppCommand(target.session.windowState, target.windowId, {
    command: personaCommandFor(toolName),
    // `personaId` is stamped by the server, last, so it wins over any argument of the
    // same name: the iframe must know *which* character is remembering, and a model
    // that can name one is a model that can write another character's memory.
    params: { ...args, personaId: record.subId },
  });
}

/**
 * Register the calling sub-agent's app-defined tools, or nothing at all.
 *
 * `server.registerTool` is given the app's own name and description verbatim — that
 * is the point of the grade — while the handler is this module's, identical for every
 * name.
 */
export function registerSubAgentTools(server: McpServer): void {
  const record = callingSubAgent();
  if (!record) return;

  for (const spec of record.tools as SubAgentToolSpec[]) {
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema: inputShape(spec.input) },
      async (args: Record<string, unknown>) => ({
        ...(await dispatchSubAgentTool(record, spec.name, args ?? {})),
      }),
    );
  }
}
