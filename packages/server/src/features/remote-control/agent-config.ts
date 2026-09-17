/**
 * Make the hosted Remote Control session a YAAR monitor agent rather than a stock
 * Claude Code.
 *
 * `claude remote-control` takes no `--mcp-config`, `--system-prompt` or `--tools`, but
 * the sessions it spawns read their working directory and inherit its environment. So
 * the monitor agent's options are built by the same `buildSDKOptions` a real monitor
 * turn goes through, and each field is written where a plain CLI will find it:
 *
 * | SDK option     | Remote Control session                                          |
 * |----------------|-----------------------------------------------------------------|
 * | `env`          | the spawn env of `remote-control` (children inherit it)         |
 * | `mcpServers`   | `<cwd>/.mcp.json`, header values as `${VAR}` refs into that env |
 * | `systemPrompt` | `<cwd>/.claude/output-styles/yaar.md`, coding instructions off  |
 * | `allowedTools` | `permissions.allow` in `<cwd>/.claude/settings.json`            |
 * | `tools`        | `permissions.deny` for every built-in the SDK set leaves out    |
 * | `model`        | `model` in the same settings                                    |
 *
 * Header values never touch disk: the bearer and the agent token are secrets, so the
 * file names env vars and the spawn env carries the values.
 *
 * The directory is generated into `config/remote-control/` (git-ignored with the rest
 * of `config/`) and rewritten on every start, so it cannot drift from the options.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getConfigDir } from '../../config.js';

/** The agent id the hosted session's MCP token is minted for. */
export const REMOTE_AGENT_ID = 'remote-control';

const OUTPUT_STYLE = 'yaar';

/**
 * Claude Code built-ins a YAAR monitor agent does not have. The SDK expresses this as
 * an allowlist (`tools`); settings can only deny, so the complement is spelled out.
 * A name the running CLI does not know is an inert rule.
 */
const CLI_BUILTIN_TOOLS = [
  'Agent',
  'Bash',
  'BashOutput',
  'Edit',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'KillShell',
  'LSP',
  'MultiEdit',
  'NotebookEdit',
  'Read',
  'Skill',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
];

export interface RemoteAgentConfig {
  cwd: string;
  env: Record<string, string>;
}

/**
 * Build the monitor agent's SDK options for `monitorId` and write them out. Mints the
 * {@link REMOTE_AGENT_ID} token as a side effect.
 *
 * Imports are dynamic because this module is reached from the verb registry, and the
 * profile/provider graph it needs already reaches back into the registry at import time.
 */
export async function writeRemoteAgentConfig(monitorId: string): Promise<RemoteAgentConfig> {
  const [{ buildSDKOptions }, { getOrchestratorPrompt }, { getMonitorTurnOptions }, sp, roles] =
    await Promise.all([
      import('../../providers/claude/sdk-options.js'),
      import('../../agents/profiles/orchestrator/index.js'),
      import('../../agents/profiles/turn-options.js'),
      import('../../agents/system-prompt.js'),
      import('../../agents/roles.js'),
    ]);

  const turn = getMonitorTurnOptions('claude');
  const systemPrompt = await sp.assembleSystemPromptForRole(
    getOrchestratorPrompt(),
    roles.monitorRole(monitorId),
    'claude',
    monitorId,
  );
  const options = buildSDKOptions({
    options: {
      systemPrompt,
      model: turn.model,
      allowedTools: turn.allowedTools,
      monitorId,
      agentId: REMOTE_AGENT_ID,
    },
    defaultSystemPrompt: systemPrompt,
    abortController: new AbortController(),
    onEscapeGuard: () => {},
  });

  // `agentId` makes buildSDKOptions mint this principal's token into the MCP headers,
  // exactly as for a pooled agent. Revoking it is the host's job when the process exits.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.env ?? {})) {
    if (typeof v === 'string') env[k] = v;
  }

  const secretVars = new Map<string, string>(); // header value → env var name
  const envRef = (value: string): string => {
    let name = secretVars.get(value);
    if (!name) {
      name = `YAAR_MCP_HEADER_${secretVars.size}`;
      secretVars.set(value, name);
      env[name] = value;
    }
    return `\${${name}}`;
  };

  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(options.mcpServers ?? {})) {
    if (!('url' in server)) continue;
    const headers: Record<string, string> = {};
    for (const [h, v] of Object.entries(server.headers ?? {})) headers[h] = envRef(v);
    mcpServers[name] = { type: server.type, url: server.url, headers };
  }

  const tools = new Set(Array.isArray(options.tools) ? options.tools : []);
  const settings = {
    enableAllProjectMcpServers: true,
    outputStyle: OUTPUT_STYLE,
    ...(options.model ? { model: options.model } : {}),
    permissions: {
      allow: options.allowedTools ?? [],
      deny: [
        ...CLI_BUILTIN_TOOLS.filter((t) => !tools.has(t)),
        ...(options.disallowedTools ?? []),
      ].filter((t, i, all) => all.indexOf(t) === i),
    },
  };

  const outputStyle =
    '---\n' +
    `name: ${OUTPUT_STYLE}\n` +
    'description: YAAR monitor agent\n' +
    'keep-coding-instructions: false\n' +
    '---\n\n' +
    (typeof options.systemPrompt === 'string' ? options.systemPrompt : systemPrompt) +
    '\n';

  const cwd = join(getConfigDir(), 'remote-control');
  mkdirSync(join(cwd, '.claude', 'output-styles'), { recursive: true });
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers }, null, 2) + '\n');
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  writeFileSync(join(cwd, '.claude', 'output-styles', `${OUTPUT_STYLE}.md`), outputStyle);

  return { cwd, env };
}
