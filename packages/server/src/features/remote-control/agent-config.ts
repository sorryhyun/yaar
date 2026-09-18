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
 * | per-turn prompt| a `UserPromptSubmit` HTTP hook in the same settings             |
 *
 * Two things are deliberately not the local monitor's. The prompt is the remote variant
 * (`getRemoteOrchestratorPrompt`): the user reads the chat on claude.ai, and the per-turn
 * context the local monitor is fed — timeline, reload options, relays — never arrives,
 * so the reload tools that only serve that context are dropped from the tool set too.
(The timeline and open windows do arrive, through the hook — see `turn-context.ts`.)
 * And the CLI defers MCP tools behind ToolSearch where the SDK path loads them up front,
 * so the env turns that off (`ENABLE_TOOL_SEARCH=false`, an explicit opt-out that also
 * beats the service-side force flag).
 *
 * Header values never touch disk: the bearer and the agent token are secrets, so the
 * file names env vars and the spawn env carries the values.
 *
 * The directory is generated into `config/remote-control/` (git-ignored with the rest
 * of `config/`) and rewritten on every start, so it cannot drift from the options.
 *
 * Which makes it a directory *inside* the YAAR checkout, and a plain CLI does not read
 * only its cwd: subagents, skills and `settings.local.json` are searched from the cwd up
 * to the **repository** root, and `CLAUDE.md` from the cwd up to the filesystem root. Left
 * alone, the monitor agent inherits YAAR's own developer config — the repo's
 * `.claude/agents/*` offered as subagent types, its skills, its `CLAUDE.md` — none of
 * which a monitor agent has any business with. Two lines close both walks:
 * {@link writeRepoRoot} makes the directory its own repository root, and
 * `CLAUDE_CODE_DISABLE_CLAUDE_MDS` turns off memory files (auto-memory included).
 *
 * Severing the repo also severs the repo's **workspace trust**, which is keyed by the
 * same git root — so {@link grantWorkspaceTrust} records the one this directory now
 * needs. Without it `remote-control` refuses to start at all.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getConfigDir } from '../../config.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('RemoteControl');

/** The agent id the hosted session's MCP token is minted for. */
export const REMOTE_AGENT_ID = 'remote-control';

const OUTPUT_STYLE = 'yaar';

/** Where the session's `UserPromptSubmit` hook fetches its turn context (`turn-context.ts`). */
export const TURN_CONTEXT_PATH = '/mcp/hooks/user-prompt-submit';
/** Seconds the CLI waits on the hook before starting the turn without it. */
const TURN_CONTEXT_TIMEOUT = 5;

/**
 * Claude Code built-ins a YAAR monitor agent does not have. The SDK expresses this as
 * an allowlist (`tools`); settings can only deny, so the complement is spelled out.
 * A name the running CLI does not know is an inert rule.
 */
const CLI_BUILTIN_TOOLS = [
  'Agent',
  'Bash',
  'BashOutput',
  'CronCreate',
  'CronDelete',
  'CronList',
  'DesignSync',
  'Edit',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'FetchInboxMessage',
  'Glob',
  'Grep',
  'KillShell',
  'ListMcpResourcesTool',
  'LSP',
  'Monitor',
  'MultiEdit',
  'NotebookEdit',
  'PowerShell',
  'PushNotification',
  'Read',
  'ReadMcpResourceTool',
  'RemoteTrigger',
  'REPL',
  'ScheduleWakeup',
  'SendMessage',
  'Skill',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
];

/**
 * Env the remote session needs on top of the monitor agent's. The SDK path gets MCP
 * tools loaded up front; the CLI defers them behind ToolSearch unless told not to, which
 * cost the first remote turn a round trip just to load YAAR's own verbs.
 */
const REMOTE_ENV_OVERRIDES = {
  ENABLE_TOOL_SEARCH: 'false',
  // The monitor agent's instructions are its system prompt. `CLAUDE.md` discovery walks to
  // the filesystem root — past the YAAR checkout — and no repo-root marker stops it, so the
  // only way to keep the repo's developer instructions (and auto-memory) out is to say no.
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
} as const;

/**
 * Make the generated directory its own repository root.
 *
 * The CLI resolves "the project" with git, and searches every `.claude/` between the cwd
 * and that root. A `.git` here ends the search one level below YAAR's, so the repo's
 * agents, skills and `settings.local.json` stop being this session's. Written by hand
 * rather than shelled out to `git init`: this is four inert files, and the host must not
 * depend on a git binary to start.
 */
function writeRepoRoot(cwd: string): void {
  const git = join(cwd, '.git');
  if (existsSync(join(git, 'HEAD'))) return;
  mkdirSync(join(git, 'objects'), { recursive: true });
  mkdirSync(join(git, 'refs', 'heads'), { recursive: true });
  writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(git, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n');
}

/**
 * Record the generated directory as a trusted workspace.
 *
 * The CLI refuses to run in a directory whose trust dialog was never accepted, and that
 * dialog cannot be answered here — `remote-control` prints the refusal and exits, which
 * reads on the desktop as a host that dies the moment it is switched on. Trust is keyed
 * by the *git root*, so before {@link writeRepoRoot} this directory rode on the YAAR
 * checkout's own accepted dialog; it no longer can, by design.
 *
 * Settings cannot grant it — the flag lives only in the CLI's global `~/.claude.json`,
 * and the CLI's own refusal names writing it there as the way out. So that is what this
 * does, for this one generated path and nothing else: read, add the key if it is missing,
 * write back through a temp file so a crash cannot leave the user a truncated config.
 * The common case is a no-op, since the entry survives the first start.
 *
 * Failure is not fatal. A config that cannot be read or written leaves the CLI to print
 * its own refusal into the terminal tail, where the app already shows it.
 */
function grantWorkspaceTrust(cwd: string): void {
  const configDir = process.env.CLAUDE_CONFIG_DIR || homedir();
  const file = join(configDir, '.claude.json');
  try {
    // No file yet is a CLI that has never run. Still this function's answer to give —
    // an unreadable *existing* file is the case that falls through to the catch.
    const raw = existsSync(file) ? readFileSync(file, 'utf8') : '{}';
    const config = JSON.parse(raw) as {
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    if (config.projects?.[cwd]?.hasTrustDialogAccepted) return;
    config.projects ??= {};
    config.projects[cwd] = { ...config.projects[cwd], hasTrustDialogAccepted: true };
    const tmp = `${file}.yaar-${process.pid}`;
    // The rename replaces the file, so the mode is this write's to get right: the config
    // carries the CLI's account state and is the user's alone (`0600`), where a default
    // `writeFileSync` would publish it to the group at `0644`.
    writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
    log.info('recorded workspace trust for the remote-control directory', { file });
  } catch (err) {
    log.warn('could not record workspace trust; the CLI may refuse to start', {
      file,
      error: String(err),
    });
  }
}

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
  const [
    { buildSDKOptions },
    { getRemoteOrchestratorPrompt },
    { getMonitorTurnOptions },
    sp,
    roles,
    { buildEnvironmentSection },
    { SYSTEM_TOOL_NAMES },
  ] = await Promise.all([
    import('../../providers/claude/sdk-options.js'),
    import('../../agents/profiles/orchestrator/index.js'),
    import('../../agents/profiles/turn-options.js'),
    import('../../agents/system-prompt.js'),
    import('../../agents/roles.js'),
    import('../../providers/environment.js'),
    import('../../mcp/system/tool-names.js'),
  ]);

  const turn = getMonitorTurnOptions('claude');
  const systemPrompt = await sp.assembleSystemPromptForRole(
    getRemoteOrchestratorPrompt(),
    roles.monitorRole(monitorId),
    'claude',
    monitorId,
    // Onboarding waits for a desktop click that never reaches a remote session.
    { buildEnvironment: (provider) => buildEnvironmentSection(provider, { onboarding: false }) },
  );
  // reload_cached / list_reload_options replay `<reload_options>`, which only a local
  // monitor turn is given.
  const reloadTools = new Set<string>(SYSTEM_TOOL_NAMES);
  const allowedTools = turn.allowedTools?.filter((t) => !reloadTools.has(t));
  const options = buildSDKOptions({
    options: {
      systemPrompt,
      model: turn.model,
      allowedTools,
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
  Object.assign(env, REMOTE_ENV_OVERRIDES);

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

  // The hook authenticates exactly as the MCP calls do, so it reuses their headers — and
  // their env refs, which the CLI interpolates only for names listed in `allowedEnvVars`.
  const mcpServer = Object.values(options.mcpServers ?? {}).find((srv) => 'url' in srv);
  const hookHeaders: Record<string, string> = {};
  if (mcpServer && 'url' in mcpServer) {
    for (const [h, v] of Object.entries(mcpServer.headers ?? {})) hookHeaders[h] = envRef(v);
  }
  const hooks =
    mcpServer && 'url' in mcpServer
      ? {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: 'http',
                  url: new URL(TURN_CONTEXT_PATH, mcpServer.url).href,
                  headers: hookHeaders,
                  allowedEnvVars: [...secretVars.values()],
                  timeout: TURN_CONTEXT_TIMEOUT,
                },
              ],
            },
          ],
        }
      : undefined;

  const tools = new Set(Array.isArray(options.tools) ? options.tools : []);
  const settings = {
    enableAllProjectMcpServers: true,
    outputStyle: OUTPUT_STYLE,
    // A monitor agent's capabilities are YAAR's verbs; Claude Code's own bundled skills
    // are not among them, and `Skill` is denied below anyway.
    disableBundledSkills: true,
    ...(options.model ? { model: options.model } : {}),
    ...(hooks ? { hooks } : {}),
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
  writeRepoRoot(cwd);
  grantWorkspaceTrust(cwd);
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers }, null, 2) + '\n');
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  writeFileSync(join(cwd, '.claude', 'output-styles', `${OUTPUT_STYLE}.md`), outputStyle);

  return { cwd, env };
}
