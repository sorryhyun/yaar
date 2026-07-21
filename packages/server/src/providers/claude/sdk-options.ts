/**
 * Builds the Claude Agent SDK `Options` for one turn.
 *
 * Owns the three things a turn's options are assembled from: the tool/model
 * identity carried by `TransportOptions`, the per-agent MCP server set, and the
 * scrubbed environment the spawned CLI process runs in. Turn and lifecycle
 * management stay in the provider.
 */

import type { Options as SDKOptions } from '@anthropic-ai/claude-agent-sdk';
import type { TransportOptions } from '../types.js';
import { getToolNames, getMcpToken } from '../../mcp/index.js';
import {
  getStorageDir,
  resolveClaudeBinPath,
  buildClaudeEnv,
  CLAUDE_STATIC_SDK_OPTIONS,
} from '../../config.js';
import { buildMcpServerSet } from '../mcp-servers.js';

/** Inputs to the SDK options builder for one turn. */
export interface SDKOptionsRequest {
  /** Session id to resume (undefined = fresh conversation). */
  resumeSession?: string;
  /** The turn's transport options — supplies prompt/model/agent/tool identity. */
  options: TransportOptions;
  /** Provider's own prompt, used when the turn supplies none. */
  defaultSystemPrompt: string;
  /** The controller to bind to the process this turn's stream spawns. */
  abortController: AbortController;
}

/**
 * Get SDK options for queries.
 */
export function buildSDKOptions({
  resumeSession,
  options,
  defaultSystemPrompt,
  abortController,
}: SDKOptionsRequest): SDKOptions {
  const { systemPrompt, agentId, allowedTools } = options;

  // Only enable builtin tools if allowedTools includes them (or is unfiltered)
  const effectiveAllowed = allowedTools ?? getToolNames();
  const builtinTools: SDKOptions['tools'] = [];
  if (!allowedTools || allowedTools.includes('WebSearch')) {
    builtinTools.push('WebSearch');
  }

  // Build MCP server configs — only include servers needed by allowedTools.
  // This prevents the 'app' MCP server from being connected for monitor agents.
  const neededServers = new Set<string>();
  for (const tool of effectiveAllowed) {
    const m = tool.match(/^mcp__(\w+)__/);
    if (m) neededServers.add(m[1]);
  }

  // Authorization is transport auth (this process is one YAAR spawned). X-Agent-Token
  // is the principal: a credential minted for this agent alone, which the server maps
  // back to its id. The agent id itself is never sent — asserting it in a header is
  // what let any agent claim to be the session agent.
  const mcpHeaders: Record<string, string> = {
    Authorization: `Bearer ${getMcpToken()}`,
  };
  const { servers, agentToken } = buildMcpServerSet(agentId, (name) => neededServers.has(name));
  if (agentToken) {
    mcpHeaders['X-Agent-Token'] = agentToken;
  }

  const mcpServerConfigs = Object.fromEntries(
    servers.map(({ name, url }) => [
      name,
      {
        type: 'http' as const,
        url,
        headers: mcpHeaders,
      },
    ]),
  );
  if (!allowedTools || allowedTools.includes('Task')) {
    builtinTools.push('Task');
  }

  const claudeBin = resolveClaudeBinPath();

  return {
    // Static hardening/policy + spawned-CLI env live in config/providers/claude.ts.
    ...CLAUDE_STATIC_SDK_OPTIONS,
    env: buildClaudeEnv(),
    abortController,
    ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
    systemPrompt: systemPrompt ?? defaultSystemPrompt,
    // `||`, not `??`: an empty model string falls back to the default, as it
    // did when callers patched the model in with `if (options.model)`.
    model: options.model || 'claude-sonnet-5',
    resume: resumeSession,
    cwd: getStorageDir(),
    tools: builtinTools,
    allowedTools: effectiveAllowed,
    mcpServers: mcpServerConfigs,
  };
}
