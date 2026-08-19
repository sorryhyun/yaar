/**
 * Locating, spawning, and configuring the `claude` CLI.
 */

import type { Options as SDKOptions } from '@anthropic-ai/claude-agent-sdk';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { IS_BUNDLED_EXE } from '../env.js';
import { MCP_TOOL_CALL_TIMEOUT_MS } from '../deadlines.js';

/**
 * Resolve the absolute path to the claude binary (exe/binary only, not .cmd wrappers).
 * Returns null if no binary is found on disk.
 *
 * Used by the Agent SDK's `pathToClaudeCodeExecutable` option so the SDK doesn't
 * need to locate its own bundled binary (which is inaccessible in a compiled exe).
 */
export function resolveClaudeBinPath(): string | null {
  const ext = process.platform === 'win32' ? '.exe' : '';

  // 1. Honor CLAUDE_CODE_PATH override (.env or shell)
  const override = process.env.CLAUDE_CODE_PATH;
  if (override && existsSync(override)) return override;

  // 2. Check next to the executable (bundled exe ships claude alongside)
  if (IS_BUNDLED_EXE) {
    const localBin = join(dirname(process.execPath), `claude${ext}`);
    if (existsSync(localBin)) return localBin;
  }

  // 3. Check ~/.local/bin/ (standard install location on Windows and Linux)
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    const dotLocalBin = join(home, '.local', 'bin', `claude${ext}`);
    if (existsSync(dotLocalBin)) return dotLocalBin;
  }

  return null;
}

/**
 * Get the claude CLI spawn args (command + prefix args).
 * Uses resolveClaudeBinPath() first, then falls back to .cmd wrappers on Windows,
 * then bare 'claude' from PATH.
 *
 * Returns `[cmd, ...prefixArgs]` — callers should spread this before their own args:
 *   `Bun.spawn([...getClaudeSpawnArgs(), '--version', ...])`
 */
export function getClaudeSpawnArgs(): string[] {
  const binPath = resolveClaudeBinPath();
  if (binPath) return [binPath];

  if (IS_BUNDLED_EXE && process.platform === 'win32') {
    // .cmd wrappers need `cmd /c` to execute via uv_spawn
    const npmPrefix = process.env.APPDATA ? join(process.env.APPDATA, 'npm') : null;
    if (npmPrefix) {
      const cmdPath = join(npmPrefix, 'claude.cmd');
      if (existsSync(cmdPath)) return ['cmd', '/c', cmdPath];
    }
  }

  return ['claude'];
}

// ── Spawned-CLI environment ───────────────────────────────────────────

/**
 * Vars the parent Claude Code harness leaks that would bind the spawned child
 * CLI to parent-only resources (FDs, session ids, host-managed mode). When YAAR
 * runs inside another Claude Code harness (e.g. a cloud sandbox) they must be
 * stripped so the child starts clean — this scrub is what makes YAAR-in-Claude
 * work; without it the inner `claude` inherits the outer's FD-based auth and
 * exits with code 1.
 */
const PARENT_HARNESS_ENV_VARS = [
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_CONTAINER_ID',
  'CLAUDE_CODE_REMOTE',
  'CLAUDECODE',
] as const;

/**
 * YAAR overrides layered onto the scrubbed parent env. Disable the CLI's built-in
 * agents, auto-memory, bundled skills, CLAUDE.md loading, git instructions, and
 * claude.ai MCP servers — none apply to YAAR's short-lived, app-scoped agents —
 * and raise the MCP output and tool-call ceilings.
 *
 * `MAX_MCP_OUTPUT_TOKENS` is **not** the knob that keeps a large tool result inline, and was
 * read as such for a long time. It governs image content and the over-size warning; the
 * decision to write a text result to `tool-results/` and hand the model a 2 KB preview is a
 * separate, character-counted threshold, and the only thing that moves it is the tool
 * declaring `_meta["anthropic/maxResultSizeChars"]` on itself. That is
 * `mcp/result-size.ts` — read it before raising this number in the hope of fixing a
 * persisted result.
 *
 * `MCP_TOOL_TIMEOUT` is the one that has to be raised rather than merely tuned: without
 * it the CLI aborts the HTTP request under each tool call at 60s, and YAAR's user-facing
 * waits are longer on purpose. Left at the default, a prompt the agent had already given
 * up on stayed live on the user's screen until its own deadline passed minutes later. See
 * `config/deadlines.ts` for the three nested bounds.
 *
 * The two `MCP_*` generation/negotiation vars put the CLI on YAAR's **stateless**
 * 2026-07-28 MCP leg (`mcp/server.ts`'s `getModernHandler`), which needs no session id,
 * no idle eviction, and survives a server restart with no re-handshake. Both are required
 * — `MCP_SDK_GENERATION` selects the v2 runtime arm, and only that arm reads
 * `MCP_PROTOCOL_NEGOTIATION`, so either one alone is a no-op. They are **undocumented**
 * internal gates in a CLI YAAR does not pin, which is exactly why the stateful leg stays
 * in place: a renamed gate silently falls back to legacy `initialize` and every tool keeps
 * working. Do not delete the other leg on the strength of these two lines.
 */
const CLAUDE_ENV_OVERRIDES = {
  MAX_MCP_OUTPUT_TOKENS: '131072',
  MCP_TOOL_TIMEOUT: String(MCP_TOOL_CALL_TIMEOUT_MS),
  MCP_SDK_GENERATION: 'v2',
  MCP_PROTOCOL_NEGOTIATION: 'auto',
  CLAUDE_CODE_DISABLE_BUILTIN_AGENTS: '1',
  CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH: '122880',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
  BASH_MAX_OUTPUT_LENGTH: '131072'
} as const;

/**
 * Environment for the spawned `claude` CLI: the current process env with
 * parent-harness vars scrubbed and YAAR's overrides applied. Computed per spawn
 * so a mutated `process.env` is reflected.
 */
export function buildClaudeEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const k of PARENT_HARNESS_ENV_VARS) delete env[k];
  return { ...env, ...CLAUDE_ENV_OVERRIDES };
}

// ── Static SDK options ────────────────────────────────────────────────

/**
 * Turn-independent Claude Agent SDK options — the static hardening/policy that is
 * the same for every agent tier and every turn. The per-turn options factory
 * (`providers/claude/sdk-options.ts`) spreads these and fills in the dynamic fields
 * (prompt, model, resume, tools, mcpServers, cwd, abortController, binary path, env).
 */
export const CLAUDE_STATIC_SDK_OPTIONS = {
  executable: 'bun',
  // YAAR provides no LSP integration, but the spawned `claude` CLI ships an
  // `LSP` tool by default and agents reach for it. Strip it from context so
  // they don't waste turns calling a tool that can't do anything here.
  disallowedTools: ['LSP'],
  includePartialMessages: true,
  // Ask for the reasoning summary. Opus 5 (and 4.7/4.8, Sonnet 5, Fable 5) default
  // `display` to `omitted`, which still streams `thinking` blocks but with empty text —
  // a silent change from Opus 4.6, where it was `summarized`. Under the default the
  // provider sends nothing YAAR can map for the whole reasoning phase, and measured over
  // 22 transcripts that phase is a third of all agent wall-clock (median 5.4s, p95 32s,
  // max 136s). The status bar has no liveness signal, so it sits on the label the last
  // event left behind and the agent reads as hung. Costs nothing: thinking is billed the
  // same under every `display` setting, which only controls visibility.
  thinking: { type: 'adaptive', display: 'summarized' },
  // Drop the built-in commit/PR workflow instructions from the spawned CLI's
  // system prompt. YAAR's monitor/session/app agents don't run git workflows,
  // so the instructions are pure prompt overhead. Applies to all three tiers,
  // since the options factory is the single per-turn source for the provider.
  settings: { includeGitInstructions: false },
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
} satisfies Partial<SDKOptions>;
