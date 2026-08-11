/**
 * Locating and configuring the `codex` CLI / app-server.
 */

import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { createRequire } from 'module';
import { getEnvInt, IS_BUNDLED_EXE } from '../env.js';
import { getConfigDir } from '../paths.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('codex:config');

/**
 * Where the `@openai/codex` npm package puts the real binary, per platform — the package
 * itself is an 11 KB launcher whose `bin/codex.js` resolves one of six `os`/`cpu`-gated
 * optional dependencies (the esbuild pattern; only the host's ~275-370 MB package installs).
 *
 * This table mirrors `PLATFORM_PACKAGE_BY_TARGET` in that launcher, because YAAR resolves the
 * vendored binary itself rather than spawning `bin/codex.js`. Two reasons not to go through
 * the launcher: it costs a Node process in front of every app-server, and it installs its own
 * SIGINT/SIGTERM/SIGHUP forwarding, which would sit between `AppServer` and the process group
 * `setsid -w` exists to let it signal directly (see `app-server.ts`'s `spawnProcess`).
 */
const CODEX_VENDOR_TARGETS: Record<string, { pkg: string; triple: string } | undefined> = {
  'darwin-arm64': { pkg: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
  'darwin-x64': { pkg: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
  'linux-arm64': { pkg: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
  'linux-x64': { pkg: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  'win32-arm64': { pkg: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
  'win32-x64': { pkg: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
};

/** Memoized {@link resolveVendoredCodex} — a fact of the install, not of the moment. */
let vendoredCodex: string | null | undefined;

/**
 * The `codex` binary from an installed `@openai/codex`, or null if it isn't installed.
 *
 * It is declared as an **optional peer dependency** (`packages/server/package.json`), so
 * `bun install` never downloads it and a contributor running the Claude provider pays
 * nothing. A Codex user opts in with `bun add @openai/codex`, and from then on the CLI
 * driving YAAR is pinned by the lockfile instead of being whichever binary PATH resolves
 * first — the "two codex installs at different versions" hazard `CODEX_UPGRADE_HINT`
 * warns about. `codex-version.test.ts` pins the declared range to `CODEX_MIN_VERSION` so
 * the two cannot drift.
 *
 * Auth is unaffected either way: credentials live in `$CODEX_HOME`, so a vendored binary
 * reads whatever `codex login` already wrote.
 */
function resolveVendoredCodex(): string | null {
  if (vendoredCodex !== undefined) return vendoredCodex;
  vendoredCodex = null;

  const target = CODEX_VENDOR_TARGETS[`${process.platform}-${process.arch}`];
  if (!target) return null;

  const require = createRequire(import.meta.url);
  const roots: string[] = [];
  for (const pkg of [target.pkg, '@openai/codex']) {
    try {
      roots.push(dirname(require.resolve(`${pkg}/package.json`)));
    } catch {
      // Not installed (or, for the launcher, not resolvable from here) — try the next root.
    }
  }

  const bin = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const root of roots) {
    const candidate = join(root, 'vendor', target.triple, 'bin', bin);
    if (existsSync(candidate)) {
      vendoredCodex = candidate;
      return candidate;
    }
  }
  return null;
}

/**
 * Get the codex CLI spawn args (command + prefix args).
 * When running as a bundled exe, looks for codex next to the executable first,
 * then resolves the npm global bin directory (handles Windows .cmd wrappers).
 * Then an `@openai/codex` vendored into `node_modules` ({@link resolveVendoredCodex}).
 * Falls back to 'codex' from PATH.
 *
 * The bundled-exe branch stays first: a release artifact ships its own codex beside the
 * executable and has no `node_modules` to resolve against, so what it found is what the
 * release was built and smoke-tested with.
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

  // 3. A version-pinned codex installed as an npm package
  const vendored = resolveVendoredCodex();
  if (vendored) return [vendored];

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
    log.warn('could not read config, leaving its MCP servers alone', { configPath, err });
    return [];
  }
  if (!servers || typeof servers !== 'object') return [];

  const names: string[] = [];
  for (const name of Object.keys(servers)) {
    // TOML permits quoted keys; `-c` addresses a dotted path, so a name with a dot, a space,
    // or a quote in it cannot be named without changing which key the override lands on.
    if (/^[A-Za-z0-9_-]+$/.test(name)) names.push(name);
    else log.warn('MCP server cannot be addressed by -c; leaving it on', { server: name });
  }
  return names;
}

/**
 * Rewrite codex's model catalog so YAAR's models run in **direct** tool mode with multi-agent
 * off, and return the path to the rewritten file (or `null` to leave the catalog alone).
 *
 * This exists because the model preset, not the feature flags, is what actually decides those
 * two things. `effective_tool_mode()` is `model_info.tool_mode.unwrap_or_else(|| …features…)` and
 * `resolve_multi_agent_version_for_model()` prefers `model_info.multi_agent_version` — so a
 * `-c features.code_mode=false` that `codex doctor` reports as *accepted* still changes nothing
 * when the model declares a mode, and `gpt-5.6-terra` declares both:
 *
 *   gpt-5.6-terra   tool_mode = "code_mode_only"   multi_agent_version = "v2"
 *
 * That is the whole reason YAAR's Codex agents were running model-authored JS against
 * `ALL_TOOLS` / `tools.mcp__verbs__invoke` inside an `exec` cell — the second, untracked path to
 * every tool that `code_mode` in {@link DISABLED_FEATURES} was supposed to close — and were
 * being handed six `collaboration.*` spawn/wait tools besides.
 *
 * `model_catalog_json` is the only door to those fields (`with_config_overrides` exposes
 * context window, auto-compact, tool-output limit, base instructions and personality — not
 * these). Pointing it at a file swaps the whole `ModelsManager` implementation: codex builds a
 * `StaticModelsManager` from this catalog instead of an `OpenAiModelsManager`, which is exactly
 * the behavior we want (nothing re-fetches and re-overrides our two fields) and also its one
 * cost — **while YAAR is driving, codex will not refresh `models_cache.json` or discover a new
 * model.** The cache still refreshes whenever the user runs codex normally, and this reads it
 * fresh on every spawn, so the roster tracks their CLI rather than a snapshot pinned here.
 *
 * Deriving from `models_cache.json` rather than writing a catalog by hand is the point.
 * `ModelInfo` carries the model's entire definition — `base_instructions`, context windows,
 * reasoning levels, truncation policy — and hand-authoring that would pin the model's system
 * prompt to whatever it looked like the day this was written. Here the two fields YAAR has an
 * opinion about are overwritten and every other field is passed through untouched.
 *
 * Fails open in every uncertain case (no cache file, unparseable JSON, no models, unwritable
 * config dir): the override is dropped and codex keeps its own catalog, which is the behavior
 * YAAR had before this existed. A machine where codex has never run has no cache to read — the
 * first plain `codex` run creates one and the next YAAR launch picks it up.
 */
let lastCatalogPath: string | null = null;

/**
 * The catalog path {@link getCodexAppServerArgs} last resolved, or `null` if it fell open and
 * the override was dropped. Read by the launch log so the line reports what the spawn actually
 * carries rather than recomputing (and rewriting) it.
 */
export function getModelCatalogPath(): string | null {
  return lastCatalogPath;
}

export function buildDirectToolModeCatalog(): string | null {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  const cachePath = join(codexHome, 'models_cache.json');
  if (!existsSync(cachePath)) {
    log.warn(
      'no model catalog cache; leaving the catalog alone (code mode and multi-agent stay ' +
        'whatever the model preset says). Run `codex` once to populate it.',
      { cachePath },
    );
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      models?: Array<Record<string, unknown>>;
    };
    const models = parsed?.models;
    // `load_catalog_json` refuses a catalog with no models, so an empty one would turn a
    // fail-open into a refused boot.
    if (!Array.isArray(models) || models.length === 0) return null;

    const patched = models.map((model) => ({
      ...model,
      tool_mode: 'direct',
      multi_agent_version: 'disabled',
      // `apply_patch` is gated on `model_info.apply_patch_tool_type.is_some()`, so nulling it
      // here is what takes the tool away — there is no `features.apply_patch`, and the
      // `apply_patch_freeform` flag in DISABLED_FEATURES only ever covered the freeform
      // spelling. YAAR's Codex agents edit through the clone-revise-compile-deploy flow and
      // MCP verbs, never by patching files, which is the same argument `shell_tool=false`
      // rests on; direct tool mode is what first made this tool *visible* (code mode had it
      // behind `exec`), not what introduced it.
      //
      // Its neighbor `update_plan` has no door at all: `add_core_utility_tools` calls
      // `planned_tools.add(PlanHandler)` unconditionally, there is no feature flag, and the
      // old `include_plan_tool` config key is gone. It stays on the tool list and that is not
      // something config can change.
      apply_patch_tool_type: null,
    }));

    const outPath = join(getConfigDir(), 'codex-model-catalog.json');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ models: patched }, null, 1));
    return outPath;
  } catch (err) {
    log.warn("could not rewrite the model catalog, leaving codex's own in place", { err });
    return null;
  }
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
  // Codex's own goal/plan surface: a second, Codex-internal place for an agent to record what
  // it intends to do next, which YAAR neither reads nor renders. A monitor agent's plan belongs
  // in the windows it opens and the context tape, not in a tracker only codex can see.
  'goals',
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
  // The whole plugin tier. `remote_plugin` was already here, but it only covers the *remote*
  // fetch path — `plugins` is the surface itself (a user's `~/.codex` plugins loading into
  // every YAAR thread, carrying tools and hooks nobody declared) and `plugin_sharing` is the
  // publish/consume half of it. Same argument as `detectUserMcpServers()` below: what a thread
  // holds is `buildMcpScope`'s to declare per thread, stamped with the caller's identity, and a
  // process-level tier cannot be taken away from a sub-agent whose containment is an empty tool
  // set. (`plugin_hooks` and `recommended_plugins` are already false by default.)
  'plugins',
  'plugin_sharing',
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
 * **`code_mode_host`** is deliberately *not* here. It is the *host* half of code mode: the
 * separate runtime process codex spawns and delegates `exec` cells to ("spawned code-mode
 * host has no stdin", "remote code-mode host requires the code_mode_host feature to be
 * enabled"). It is `stable` + on by default, so naming it here asserted a default we already
 * had. The half that decides whether a *model* ever gets an `exec` tool is `code_mode`, which
 * stays in {@link DISABLED_FEATURES} — that is the one carrying the "explicit MCP calls, not
 * a JS shell" rule. With the model side off the host has no caller, so the entry bought
 * nothing and only read as an opinion YAAR does not hold. If `code_mode` is ever enabled,
 * enabling the host becomes a real decision to make on its own terms.
 */
export const ENABLED_FEATURES = ['mcp_2026_07_28'];

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

  // The rewritten catalog that puts the model in `tool_mode = "direct"` with multi-agent off —
  // the only lever that reaches those two, since the model preset outranks every `features.*`
  // flag above (see `buildDirectToolModeCatalog`). Omitted entirely when it cannot be built, so
  // a machine without a codex model cache still boots.
  const catalogPath = buildDirectToolModeCatalog();
  lastCatalogPath = catalogPath;
  if (catalogPath) {
    args.push('-c', `model_catalog_json=${JSON.stringify(catalogPath)}`);
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
    // The two multi-agent developer messages, silenced. Normally redundant now — the rewritten
    // catalog above sets `multi_agent_version = "disabled"`, and both injection sites return
    // early when the version is not v2 — but kept as the belt to that suspenders: the catalog
    // rewrite fails open, and on a machine with no codex model cache these are the only thing
    // standing between the model and a 2.2 KB instruction to go be a team lead.
    //
    // What follows is why they had to exist at all. `features.multi_agent=false` above does
    // **not** reach them: `codex app-server` threads run `multi_agent_version: v2` no matter what
    // the feature flags say, because the model preset wins. `effective_tool_mode` and
    // `resolve_multi_agent_version_for_model` both read `model_info` first and only fall back to
    // `multi_agent_version_from_features()` when the model declares nothing — and `gpt-5.6-terra`
    // declares v2. Measured against codex-cli 0.147.0 with YAAR's own arg set: `codex doctor`
    // reports `multi_agent=false` accepted, and a real turn still opens with the 2.2 KB
    // "You are `/root`, the primary agent in a team of agents…" developer message plus a
    // `<multi_agent_mode>` follow-up telling the model to ignore it. Adding an explicit
    // `features.multi_agent_v2=false` changes nothing (doctor: "none").
    //
    // An **empty string** is the off switch, not a missing key: `resolve_optional_prompt_text`
    // maps `Some("")` to `None`, and the injection site only pushes an item when the text is
    // `Some`. Both messages disappear entirely — verified by reading the rollout, not inferred.
    //
    // The path is the `[features]` sub-table, not a top-level one. `multi_agent_v2.*` parses,
    // loads, and does nothing; only `features.multi_agent_v2.*` lands. Declaring the table does
    // not enable the feature (doctor still lists it disabled).
    //
    // This buys the *instructions*, not the *tools*: `collab_tools_enabled` returns true
    // unconditionally at v2, so the six `collaboration.*` tools (`spawn_agent`, `send_message`,
    // `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents`) stay on the model's tool
    // list undocumented. Nothing config-reachable removes them; the only lever that would is
    // `model_catalog_json`, which means pinning the whole `ModelInfo` — `base_instructions`
    // included — to a hand-authored snapshot.
    ['features.multi_agent_v2.root_agent_usage_hint_text', '""'],
    ['features.multi_agent_v2.subagent_usage_hint_text', '""'],
    ['features.multi_agent_v2.multi_agent_mode_hint_text', '""'],
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
