/**
 * Locating and configuring the `codex` CLI / app-server.
 */

import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { getEnvInt, getPort, IS_BUNDLED_EXE } from '../env.js';

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
 */
export function getCodexAppServerArgs(mcpNamespaces: readonly string[]): string[] {
  const args = ['app-server'];

  // Disable shell tool and apply_patch (apps use clone-revise-compile-deploy flow)
  args.push('-c', 'features.shell_tool=false');
  args.push('-c', 'features.apply_patch_freeform=false');
  args.push('-c', 'features.multi_agent=false');
  args.push('-c', 'features.personality=false');
  args.push('-c', 'features.unified_exec=false');
  args.push('-c', 'features.fast_mode=false');
  args.push('-c', 'features.skill_mcp_dependency_install=false');
  args.push('-c', 'apps._default.enabled=false');
  // Disable native memory: it injects a large `## Memory` developer message
  // (the full MEMORY_SUMMARY + lookup instructions from ~/.codex/memories) into
  // every thread. That cross-project history is irrelevant noise for YAAR's
  // short-lived, app-scoped agents.
  args.push('-c', 'features.memories=false');
  args.push('-c', 'features.apps=false');
  args.push('-c', 'features.remote_plugin=false');
  args.push('-c', 'include_permissions_instructions=false');
  args.push('-c', 'skills.include_instructions=false');

  // Configure YAAR MCP servers
  for (const ns of mcpNamespaces) {
    args.push(
      '-c',
      `mcp_servers.${ns}.url=http://127.0.0.1:${getPort()}/mcp/${ns}`,
      '-c',
      `mcp_servers.${ns}.bearer_token_env_var=YAAR_MCP_TOKEN`,
    );
  }

  // Model behavior
  args.push(
    '-c',
    'model_reasoning_effort=high',
    '-c',
    'sandbox_mode=danger-full-access',
    '-c',
    // YAAR auto-runs agents (mirrors Claude's bypassPermissions). With
    // shell_tool/apply_patch disabled, codex can only call YAAR's first-party
    // MCP tools (app/verbs/system) — those must never prompt. `on-request`
    // instead gated MCP calls through an approval the provider doesn't handle,
    // so codex declined them ("user rejected MCP tool call").
    'approval_policy=never',
    '-c',
    'project_doc_max_bytes=0',
    // Enable web search (mirrors Claude's WebSearch builtin tool). The Codex
    // message-mapper already maps webSearch items; this turns the tool on.
    '-c',
    'web_search=disabled',
  );

  return args;
}
