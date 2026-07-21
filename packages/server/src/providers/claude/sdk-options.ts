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
import { getStorageDir, resolveClaudeBinPath } from '../../config.js';
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

  // When YAAR runs inside another Claude Code harness (e.g. cloud sandbox),
  // the parent leaks vars that bind the child to parent-only resources (FDs,
  // session IDs, host-managed mode). Strip them so the spawned CLI starts clean.
  const cleanEnv = { ...process.env };
  for (const k of [
    'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
    'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
    'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_REMOTE_SESSION_ID',
    'CLAUDE_CODE_CONTAINER_ID',
    'CLAUDE_CODE_REMOTE',
    'CLAUDECODE',
  ]) {
    delete cleanEnv[k];
  }

  return {
    abortController,
    executable: 'bun',
    ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
    systemPrompt: systemPrompt ?? defaultSystemPrompt,
    // `||`, not `??`: an empty model string falls back to the default, as it
    // did when callers patched the model in with `if (options.model)`.
    model: options.model || 'claude-sonnet-4-6',
    resume: resumeSession,
    cwd: getStorageDir(),
    tools: builtinTools,
    allowedTools: effectiveAllowed,
    // YAAR provides no LSP integration, but the spawned `claude` CLI ships an
    // `LSP` tool by default and agents reach for it. Strip it from context so
    // they don't waste turns calling a tool that can't do anything here.
    disallowedTools: ['LSP'],
    mcpServers: mcpServerConfigs,
    includePartialMessages: true,
    // Drop the built-in commit/PR workflow instructions from the spawned CLI's
    // system prompt. YAAR's monitor/session/app agents don't run git workflows,
    // so the instructions are pure prompt overhead. Applies to all three tiers,
    // since this builder is the single per-turn options factory for the provider.
    settings: { includeGitInstructions: false },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    env: {
      ...cleanEnv,
      MAX_MCP_OUTPUT_TOKENS: '131072',
      CLAUDE_CODE_DISABLE_BUILTIN_AGENTS: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
    },
  };
}
