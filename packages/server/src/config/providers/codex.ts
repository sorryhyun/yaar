/**
 * Locating and configuring the `codex` CLI / app-server.
 */

import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { getEnvInt, IS_BUNDLED_EXE } from '../env.js';

/**
 * Get the codex CLI spawn args (command + prefix args).
 * When running as a bundled exe, looks for codex next to the executable first,
 * then resolves the npm global bin directory (handles Windows .cmd wrappers).
 * Falls back to 'codex' from PATH.
 *
 * Returns `[cmd, ...prefixArgs]` — callers should spread this before their own args:
 *   `Bun.spawn([...getCodexSpawnArgs(), 'app-server', ...])`
 */
export function getCodexSpawnArgs(): string[] {
  if (IS_BUNDLED_EXE) {
    // 1. Check next to the executable
    const ext = process.platform === 'win32' ? '.exe' : '';
    const localBin = join(dirname(process.execPath), `codex${ext}`);
    if (existsSync(localBin)) return [localBin];

    // 2. On Windows, resolve npm global bin (codex.cmd wrapper)
    //    .cmd files need `cmd /c` to execute via uv_spawn
    if (process.platform === 'win32') {
      const npmPrefix = process.env.APPDATA ? join(process.env.APPDATA, 'npm') : null;
      if (npmPrefix) {
        const cmdPath = join(npmPrefix, 'codex.cmd');
        if (existsSync(cmdPath)) return ['cmd', '/c', cmdPath];
      }
    }
  }
  return ['codex'];
}

// ── Codex app-server configuration ────────────────────────────────────

/** Default port for the codex app-server WebSocket listener. */
export const CODEX_WS_PORT = getEnvInt('CODEX_WS_PORT', 4510);

/** Get the codex app-server WebSocket port (env override or default). */
export function getCodexWsPort(): number {
  return CODEX_WS_PORT;
}

/**
 * Build the CLI args for `codex app-server`.
 * Separates config from process management so it's easy to review/change.
 *
 * Deliberately declares no `mcp_servers`: YAAR's namespaces are declared per thread by
 * `CodexProvider.buildMcpScope`, which is the only place that can stamp the calling
 * agent's identity onto them. See `app-server.ts`'s `spawnProcess`.
 */
export function getCodexAppServerArgs(): string[] {
  const args = ['app-server'];

  // Native Codex tool/feature surfaces we force OFF (each → `-c features.<name>=false`).
  // YAAR provides equivalents through its own MCP verbs / apps and wants explicit,
  // YAAR-tracked orchestration; leaving one on gives the agent a second, untracked
  // path that bypasses YAAR's window/agent model.
  const DISABLED_FEATURES = [
    'shell_tool', // apps use the clone-revise-compile-deploy flow, not shell/apply_patch
    'apply_patch_freeform',
    'multi_agent', // orchestration is separate YAAR-tracked threads, not Codex-internal subagents
    'collaboration_modes', // native multi-agent collab (mirrors multi_agent)
    'personality',
    'unified_exec',
    // "code mode": Codex otherwise exposes a single `exec` tool that runs model-authored
    // JS against an `ALL_TOOLS`/`text()` runtime. code_mode_host is stable+true by default,
    // so disable both host and model sides — YAAR wants explicit MCP calls, not a JS shell.
    'code_mode.enabled',
    'code_mode_host',
    'fast_mode',
    'skill_mcp_dependency_install',
    'image_generation', // image gen is the first-party `anima` app, not Codex's built-in tool
    'computer_use', // browser/computer driven via the Browser app + yaar://session/browser
    'browser_use',
    'skill_search', // YAAR curates skills (yaar://skills) and exposes its MCP tools directly
    'tool_search_always_defer_mcp_tools', // ...so don't defer our verbs behind a search tool
    'workspace_dependencies', // no host workspace to scan (isolated temp cwd)
    // Native memory injects a large `## Memory` developer message (MEMORY_SUMMARY +
    // lookup instructions from ~/.codex/memories) into every thread — cross-project
    // noise for YAAR's short-lived, app-scoped agents.
    'memories',
    'apps',
    'remote_plugin',
  ];
  for (const feature of DISABLED_FEATURES) {
    args.push('-c', `features.${feature}=false`);
  }

  // MCP servers the *user's* ~/.codex/config.toml may declare, forced off. A per-thread
  // `mcp_servers` override merges over the loaded config rather than replacing it (see
  // `app-server.ts`'s `spawnProcess`), so a server the user has configured cannot be taken
  // away per thread — it rides along on every YAAR thread, including a sub-agent's, whose
  // containment is precisely an empty tool set. Both entries are ChatGPT desktop app
  // installs, present on every Mac that runs it: `node_repl` is JS execution + browser
  // driving (the same untracked shell `code_mode`/`unified_exec` are disabled above to
  // close), `computer-use` drives the desktop. The matching *features* are already off
  // above, but a feature flag and a configured MCP server are two separate delivery paths
  // to the same capability — the user's config.toml declares these directly, and only an
  // `enabled=false` here takes one away.
  const DISABLED_MCP_SERVERS = ['node_repl', 'computer-use'];
  for (const name of DISABLED_MCP_SERVERS) {
    args.push('-c', `mcp_servers.${name}.enabled=false`);
  }

  // Non-feature scalar config overrides (`-c key=value`), in order: suppressions first,
  // then model behavior.
  const CONFIG_OVERRIDES: Array<[string, string]> = [
    ['apps._default.enabled', 'false'],
    ['include_permissions_instructions', 'false'],
    ['skills.include_instructions', 'false'],
    ['model_reasoning_effort', 'high'],
    ['sandbox_mode', 'danger-full-access'],
    // YAAR auto-runs agents (mirrors Claude's bypassPermissions). With shell_tool/apply_patch
    // disabled, codex can only call YAAR's first-party MCP tools (app/verbs/system) — those
    // must never prompt. `on-request` gated MCP calls through an approval the provider doesn't
    // handle, so codex declined them ("user rejected MCP tool call").
    ['approval_policy', 'never'],
    ['project_doc_max_bytes', '0'],
    // Web search stays off — YAAR controls HTTP access via MCP tools. (The Codex message-mapper
    // already maps webSearch items, so flip to "enabled" here to turn the builtin tool on.)
    ['web_search', 'disabled'],
  ];
  for (const [key, value] of CONFIG_OVERRIDES) {
    args.push('-c', `${key}=${value}`);
  }

  return args;
}
