/**
 * Locating and configuring the `codex` CLI / app-server.
 */

import { join, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
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

/**
 * Names of the MCP servers the *user's* codex config declares, read from the same file the
 * spawned CLI will load (`$CODEX_HOME/config.toml`, default `~/.codex/config.toml` — the spawn
 * inherits `process.env`, so resolving it the same way here is what keeps the two in sync).
 *
 * This has to be detected rather than listed. A `-c mcp_servers.<name>.enabled=false` for a
 * server the config does *not* declare does not disable anything — it creates a table holding
 * only `enabled`, and codex refuses to boot on it:
 *
 *   Error: error loading default config after config error: invalid transport
 *   in `mcp_servers.<name>`
 *
 * So a hard-coded roster is a roster of names that must exist on every machine YAAR runs on.
 * The two it used to carry (`node_repl`, `computer-use`) are ChatGPT desktop installs, which
 * made codex unspawnable anywhere ChatGPT was absent — that is why the block spent a while
 * commented out. Reading the config first turns the roster into a consequence of the machine.
 *
 * Fails open in every uncertain case (missing file, unparseable TOML, a quoted key that a
 * dotted `-c` path cannot address): the cost of a miss is one user server riding along, the
 * cost of a wrong guess is a provider that will not start.
 */
export function detectUserMcpServers(): string[] {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  const configPath = join(codexHome, 'config.toml');
  if (!existsSync(configPath)) return [];

  let servers: unknown;
  try {
    const parsed = Bun.TOML.parse(readFileSync(configPath, 'utf8')) as {
      mcp_servers?: unknown;
    };
    servers = parsed?.mcp_servers;
  } catch (err) {
    console.warn(`[codex] Could not read ${configPath}, leaving its MCP servers alone:`, err);
    return [];
  }
  if (!servers || typeof servers !== 'object') return [];

  const names: string[] = [];
  for (const name of Object.keys(servers)) {
    // TOML permits quoted keys; `-c` addresses a dotted path, so a name with a dot, a space,
    // or a quote in it cannot be named without changing which key the override lands on.
    if (/^[A-Za-z0-9_-]+$/.test(name)) names.push(name);
    else console.warn(`[codex] MCP server "${name}" cannot be addressed by -c; leaving it on`);
  }
  return names;
}

export const CODEX_WS_PORT = getEnvInt('CODEX_WS_PORT', 4510);

export function getCodexWsPort(): number {
  return CODEX_WS_PORT;
}

/**
 * Native Codex tool/feature surfaces we force OFF (each → `-c features.<name>=false`).
 * YAAR provides equivalents through its own MCP verbs / apps and wants explicit,
 * YAAR-tracked orchestration; leaving one on gives the agent a second, untracked
 * path that bypasses YAAR's window/agent model.
 *
 * Exported so the spawn can *say* what it asked for (`app-server.ts` logs both rosters at
 * launch). A `-c` flag codex declines is invisible otherwise — that is how a dead
 * `code_mode.enabled` and an unsettable `tool_search_always_defer_mcp_tools` both sat here
 * looking honored. The log is the list YAAR *sent*; `codex doctor --json`'s
 * "feature flag overrides" line is the list codex *accepted*, and the two are worth
 * diffing after any codex upgrade.
 */
export const DISABLED_FEATURES = [
  'shell_tool', // apps use the clone-revise-compile-deploy flow, not shell/apply_patch
  'apply_patch_freeform',
  'multi_agent', // orchestration is separate YAAR-tracked threads, not Codex-internal subagents
  'collaboration_modes', // native multi-agent collab (mirrors multi_agent)
  'personality',
  'unified_exec',
  // "code mode": Codex otherwise exposes a single `exec` tool that runs model-authored JS
  // against an `ALL_TOOLS`/`text()` runtime — a second, untracked path to every tool. This
  // is the **model-side** flag and the one that matters; the host-side runtime is opted
  // into separately in ENABLED_FEATURES below.
  //
  // The flag is a plain bool: `features.code_mode`. This read `code_mode.enabled` for a
  // while, which builds a *table* at that path and matches no flag — `codex features list`
  // showed `code_mode` sitting at its default either way, and `codex doctor --json` left it
  // out of "feature flag overrides". Harmless only because the default happened to be
  // false; `code_mode_host` was carrying the whole defense.
  'code_mode',
  'fast_mode',
  'skill_mcp_dependency_install',
  'image_generation', // image gen is the first-party `anima` app, not Codex's built-in tool
  'computer_use', // browser/computer driven via the Browser app + yaar://session/browser
  'browser_use',
  'skill_search', // YAAR curates skills (yaar://skills) and exposes its MCP tools directly
  // 'tool_search_always_defer_mcp_tools', // ...so don't defer our verbs behind a search tool
  //
  // Commented out because codex refuses to set it. It is a `removed`-stage flag pinned to
  // `true`: neither `-c features.tool_search_always_defer_mcp_tools=false` nor the
  // equivalent `--disable` moves it, and `codex doctor --json` still lists it under
  // "enabled feature flags" with YAAR's full arg set. That is not a property of the
  // `removed` stage — `collaboration_modes` is also `removed` and *does* take the
  // override — so it is this flag specifically, and re-adding it only puts a line back
  // that reads like a decision YAAR made and codex honored. Its companion `tool_search`
  // is `removed` + false, so nothing currently defers our verbs; if that changes, the
  // lever will have to be something other than this flag.
  'workspace_dependencies', // no host workspace to scan (isolated temp cwd)
  // Native memory injects a large `## Memory` developer message (MEMORY_SUMMARY +
  // lookup instructions from ~/.codex/memories) into every thread — cross-project
  // noise for YAAR's short-lived, app-scoped agents.
  'memories',
  'apps',
  'remote_plugin',
];

/**
 * Native Codex surfaces we force ON (each → `-c features.<name>=true`). Exported for the
 * same launch log as {@link DISABLED_FEATURES}.
 *
 * **`mcp_2026_07_28`** is the real gate on which MCP protocol era codex negotiates with an
 * **HTTP** MCP server — which is every server YAAR runs. `CODEX_MCP_PROTOCOL_VERSION` (set in
 * `app-server.ts`'s spawn env) is *not*: the CLI reads that var only for **stdio** servers,
 * and its refusal message says so ("unsupported CODEX_MCP_PROTOCOL_VERSION `…` for stdio MCP
 * server; expected `2026-07-28`"). Measured against codex-cli 0.147.0 with a probe MCP
 * endpoint, the two are cleanly separable:
 *
 *   env var only  → POST initialize, protocolVersion 2025-06-18, mcp-session-id, GET common
 *                   stream, tools/list                  — the 2025-era stateful leg
 *   flag only     → POST server/discover, mcp-protocol-version 2026-07-28, no session id
 *                   — the modern stateless leg, env var unset
 *
 * So the flag alone is necessary and sufficient, and without it YAAR's Codex traffic lands on
 * the deprecated leg (`mcp/server.ts`'s fenced 2025-era block) no matter what the env var
 * says. Confirm with `getMcpEraStats()`: `legacyRequestsServed` should stay 0 and the one-time
 * `[MCP] DEPRECATED protocol era:` warning should never name codex. Its stage is `under
 * development`, so this is a deliberate opt-in ahead of stabilization, not a default YAAR
 * inherits — if a codex release regresses it, drop the entry and the stateful leg silently
 * catches the fallback.
 *
 * **`code_mode_host`** is the *host* half of code mode: the separate runtime process codex
 * spawns and delegates `exec` cells to ("spawned code-mode host has no stdin", "remote
 * code-mode host requires the code_mode_host feature to be enabled"). It is `stable` + on by
 * default and is listed here to say so deliberately rather than inherit it. The half that
 * decides whether a *model* ever gets an `exec` tool is `code_mode`, which stays in
 * {@link DISABLED_FEATURES} — that is the one carrying the "explicit MCP calls, not a JS
 * shell" rule. Turning the host on without the model side gives the runtime no caller; if
 * `code_mode` is ever enabled, this entry stops being inert and that decision has to be made
 * on its own terms.
 */
export const ENABLED_FEATURES = ['mcp_2026_07_28', 'code_mode_host'];

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

  for (const feature of DISABLED_FEATURES) {
    args.push('-c', `features.${feature}=false`);
  }
  for (const feature of ENABLED_FEATURES) {
    args.push('-c', `features.${feature}=true`);
  }

  // Every MCP server the *user's* config.toml declares, forced off — whichever ones that
  // turns out to be (`detectUserMcpServers`). A per-thread `mcp_servers` override merges over
  // the loaded config rather than replacing it (see `app-server.ts`'s `spawnProcess`), so a
  // server the user has configured cannot be taken away per thread — it rides along on every
  // YAAR thread, including a sub-agent's, whose containment is precisely an empty tool set.
  // That argument is about the *delivery path*, not about which servers happen to be on it,
  // so the takeaway is all of them rather than a roster of the ones we recognize: `node_repl`
  // (JS execution + browser driving) and `computer-use` (drives the desktop) are the ChatGPT
  // desktop app's, and were the two named here, but a fourth-party server nobody listed
  // reaches a sub-agent exactly as well. Whatever a thread should hold, `buildMcpScope`
  // declares per thread and stamps with the caller's identity.
  //
  // Note this is a second delivery path, not a duplicate of `DISABLED_FEATURES`: a feature
  // flag and a configured MCP server can carry the same capability, and only an
  // `enabled=false` here takes the configured one away.
  for (const name of detectUserMcpServers()) {
    args.push('-c', `mcp_servers.${name}.enabled=false`);
  }

  // Non-feature scalar config overrides (`-c key=value`), in order: suppressions first,
  // then model behavior.
  const CONFIG_OVERRIDES: Array<[string, string]> = [
    // Silences codex's "Under-development features enabled: …" advisory, which
    // `features.mcp_2026_07_28` (ENABLED_FEATURES) earns by being an `under development` flag.
    // Not a stderr line — it arrives as a `warning` JSON-RPC notification carrying a
    // `threadId`, so it fires on *every* thread start: every monitor agent, every app agent,
    // every sub-agent, each one surfacing in the CLI panel as an `[warning]` notice
    // (`providers/codex/errors.ts` maps `warning` to one).
    //
    // Via `-c` rather than by writing `suppress_unstable_features_warning = true` into
    // `~/.codex/config.toml`, which is what the advisory itself suggests: that file is the
    // user's, and the opt-in this suppresses is YAAR's. Drop this line the moment
    // ENABLED_FEATURES holds nothing under development — the advisory is correct, and the
    // only reason to hide it is that YAAR has already recorded the tradeoff at the flag.
    ['suppress_unstable_features_warning', 'true'],
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
