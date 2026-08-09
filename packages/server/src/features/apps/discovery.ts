/**
 * App discovery — list apps and load their agent docs.
 */

import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { hasConfig } from './config.js';
import { APP_ROOTS, resolveAppDir, resolveAppSource, type AppSource } from './roots.js';
import type { AppManifest, FileAssociation } from '@yaar/shared';
import { buildYaarUri } from '@yaar/shared';
// Must stay `import type`. `http/access.ts` imports `http/iframe-tokens.ts`, which
// imports this module statically for `getAppMeta` — the cycle is closed only because
// this edge erases at compile time. Making it a value import would make it real, and
// the symptom is an undefined binding at module init, not a build error.
import type { PermissionEntry } from '../../http/access.js';
import type { Verb } from '../../handlers/uri-registry.js';
import { withoutPersonaCommands } from './persona-commands.js';
import { readAppGrant, type AppGrant } from '../../storage/app-grants.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('apps');

const ICON_IMAGE_EXTENSIONS = ['.png', '.webp', '.jpg', '.jpeg', '.gif', '.svg'];

/** Stable bytewise ordering for app IDs, independent of filesystem or locale order. */
function compareAppIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Parse permission entries from app.json, supporting both string and object formats. */
function parsePermissions(raw: unknown[]): PermissionEntry[] {
  const result: PermissionEntry[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      result.push(entry);
    } else if (
      entry &&
      typeof entry === 'object' &&
      'uri' in entry &&
      typeof (entry as { uri: unknown }).uri === 'string'
    ) {
      const obj = entry as { uri: string; verbs?: unknown };
      const parsed: PermissionEntry = { uri: obj.uri };
      if (Array.isArray(obj.verbs) && obj.verbs.every((v) => typeof v === 'string')) {
        parsed.verbs = obj.verbs as Verb[];
      }
      result.push(parsed);
    }
  }
  return result;
}

/**
 * A single entry in an app's `controls` list — another app this app is allowed
 * to drive (describe/query/command with an `appId` param). Optionally restricted
 * to specific commands.
 */
export interface ControlEntry {
  appId: string;
  /** If set, only these commands may be issued to the target app. Omit = all commands. */
  commands?: string[];
  /**
   * Open this app minimized when control has to open it.
   *
   * For an app driven purely for what it computes — `lab` running a reduction over a
   * file the caller must never pull into its own context — a window arriving on top of
   * the user's work is noise, not feedback. The iframe still mounts and loads while
   * minimized, so the app is fully drivable; it just sits in the taskbar. Ignored when
   * the app already has a window: control never minimizes something the user opened.
   */
  background?: boolean;
}

/**
 * How many sub-agents an app may run per (monitor, app).
 *
 * `"subagents": { "max": N }`, and only that. `"personas"` was accepted as an alias
 * and no longer is — no app.json in the tree or on the market ever used it except
 * `chitchats`, and carrying two spellings for one field meant every doc that mentioned
 * it had to mention both. The *wire* keeps `personaId` (URI segment, spawn param,
 * response bodies): a character is what an app spawns, a sub-agent is what YAAR runs,
 * and only the manifest had to pick one word.
 */
export interface SubAgentsEntry {
  max: number;
}

/** Nobody gets a cast of thousands: a sub-agent is a provider process. */
const MAX_SUB_AGENTS_PER_APP = 16;

/**
 * Parse `subagents` from app.json. Returns undefined for an app that does not declare
 * it, or declares it with a nonsense `max` — "may not spawn any" is the answer for
 * every app that has not asked, which is nearly all of them.
 *
 * This is what the manifest *asks for*. For a non-bundled app it is not yet what the
 * app holds — see {@link applyGrant}.
 *
 * Extra keys are ignored rather than rejected: the manifest is data on disk that
 * outlives any one YAAR build, so an app.json still carrying a field a past version
 * read should degrade to "the parts I understand" rather than to "cannot spawn".
 */
export function parseSubAgents(meta: { subagents?: unknown }): SubAgentsEntry | undefined {
  const raw = meta.subagents as { max?: unknown } | undefined;
  if (!raw || typeof raw !== 'object') return undefined;

  const max = Number(raw.max);
  if (!Number.isInteger(max) || max <= 0) return undefined;

  return { max: Math.min(max, MAX_SUB_AGENTS_PER_APP) };
}

/**
 * Does this manifest still use the retired `personas` spelling?
 *
 * Dropping an accepted key turns a working app into a silently inert one, and the app
 * that hits this is `chitchats` — published at v1.1.1 declaring `personas`, so every
 * install of it stops spawning until it is republished. That failure has to be
 * *legible*: this is what lets the refusal say "rename it" instead of "add it", which
 * is the same trap the bundled-only gate used to set.
 */
export function usesRetiredPersonasKey(meta: { subagents?: unknown; personas?: unknown }): boolean {
  return !parseSubAgents(meta) && !!meta.personas && typeof meta.personas === 'object';
}

/**
 * Narrow what a manifest declares down to what its source entitles it to.
 *
 * A bundled app's manifest ships with the release, so it is taken at its word. An
 * installed app's is a request, and the answer is whatever the user approved at
 * install time (`config/app-grants.json`) — **intersected**, never substituted: an app
 * that holds `yaar-dev` can rewrite its own app.json, so a grant of `max: 2` must stay
 * a ceiling of 2 no matter what the file says afterwards.
 *
 * `null` for the grant means an install that predates the dialog, or one the user
 * declined — both resolve to "declared, holds nothing", which is what
 * {@link subAgentDenialReason} exists to explain.
 */
function applyGrant(
  source: AppSource | null,
  grant: AppGrant | null,
  declared: { subagents?: SubAgentsEntry; streams?: string[] },
): { subagents?: SubAgentsEntry; streams?: string[] } {
  if (source === 'bundled') return declared;

  const result: { subagents?: SubAgentsEntry; streams?: string[] } = {};
  if (declared.subagents && grant?.subagents) {
    const max = Math.min(declared.subagents.max, grant.subagents.max);
    if (max > 0) result.subagents = { max };
  }
  if (declared.streams?.length && grant?.streams?.length) {
    const allowed = declared.streams.filter((s) => grant.streams?.includes(s));
    if (allowed.length > 0) result.streams = allowed;
  }
  return result;
}

/**
 * Why an app holds no sub-agent slots — so the refusal can name the actual fix.
 *
 * Three failures that look identical from the call site and need three different
 * sentences: the app never asked (`not-declared`); it asked and nobody has approved it
 * (`not-approved`); or it asked in the retired spelling and is being read as if it had
 * not asked at all (`retired-key`). Reporting all three as "add the field" is exactly
 * how the original bug read.
 */
export async function subAgentDenialReason(
  appId: string,
): Promise<'not-declared' | 'not-approved' | 'retired-key'> {
  const appDir = resolveAppDir(appId);
  if (!appDir) return 'not-declared';
  try {
    const meta = JSON.parse(await Bun.file(join(appDir, 'app.json')).text());
    if (usesRetiredPersonasKey(meta)) return 'retired-key';
    return parseSubAgents(meta) ? 'not-approved' : 'not-declared';
  } catch {
    return 'not-declared';
  }
}

/** Parse `controls` from app.json, supporting string shorthand and object form. */
function parseControls(raw: unknown[]): ControlEntry[] {
  const result: ControlEntry[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      result.push({ appId: entry });
    } else if (
      entry &&
      typeof entry === 'object' &&
      'appId' in entry &&
      typeof (entry as { appId: unknown }).appId === 'string'
    ) {
      const obj = entry as { appId: string; commands?: unknown; background?: unknown };
      const parsed: ControlEntry = { appId: obj.appId };
      if (Array.isArray(obj.commands) && obj.commands.every((c) => typeof c === 'string')) {
        parsed.commands = obj.commands as string[];
      }
      if (obj.background === true) parsed.background = true;
      result.push(parsed);
    }
  }
  return result;
}

export type WindowVariantType = 'standard' | 'widget' | 'panel';
export type DockEdgeType = 'top' | 'bottom';

/**
 * App criticality. `system` apps are core to the desktop: protected from
 * uninstall and auto-trusted (no permission prompt). Everything else is `app`.
 */
export type AppKind = 'system' | 'app';

export interface AppInfo {
  id: string;
  name: string;
  /** Criticality — `system` apps are protected and auto-trusted. Defaults to `app`. */
  kind: AppKind;
  /** Whether the app ships with the repo (`bundled`) or was installed (`user`). */
  source: AppSource;
  description?: string;
  icon?: string;
  iconType?: 'emoji' | 'image';
  version?: string;
  author?: string;
  hasConfig: boolean;
  createShortcut?: boolean;
  run?: string; // yaar:// URI for iframe content (e.g. yaar://apps/{id} or yaar://apps/{id}/dist/index.html)
  isCompiled?: boolean; // Has index.html (TypeScript compiled app)
  protocol?: Pick<AppManifest, 'state' | 'commands' | 'keybindings' | '$defs'>; // From protocol.json — implies appProtocol support
  fileAssociations?: FileAssociation[];
  variant?: WindowVariantType;
  dockEdge?: DockEdgeType;
  frameless?: boolean;
  windowStyle?: Record<string, string | number>;
  permissions?: PermissionEntry[];
  agentType?: string;
  /** Other apps this app may drive via the `appId` param on describe/query/command. */
  controls?: ControlEntry[];
  /** Gated `@bundled/yaar-*` SDKs this app may import (`yaar-dev`, `yaar-web`, `yaar-ml`). */
  bundles?: string[];
}

/** Build an AppInfo for a single app directory under `root`. */
async function readAppInfo(root: string, appId: string, source: AppSource): Promise<AppInfo> {
  const appPath = join(root, appId);

  const appHasConfig = await hasConfig(appId);

  let isCompiled = false;
  try {
    await stat(join(appPath, 'dist', 'index.html'));
    isCompiled = true;
  } catch {
    // Not compiled yet — isCompiled stays false.
  }

  let icon: string | undefined;
  let iconType: 'emoji' | 'image' | undefined;
  let displayName: string | undefined;
  let description: string | undefined;
  let version: string | undefined;
  let author: string | undefined;
  let createShortcut: boolean | undefined;
  let run: string | undefined;
  let kind: AppKind = 'app';
  let protocol: Pick<AppManifest, 'state' | 'commands' | 'keybindings' | '$defs'> | undefined;
  let fileAssociations: FileAssociation[] | undefined;
  let variant: WindowVariantType | undefined;
  let dockEdge: DockEdgeType | undefined;
  let frameless: boolean | undefined;
  let windowStyle: Record<string, string | number> | undefined;
  let defaultWidth: number | undefined;
  let defaultHeight: number | undefined;
  let permissions: PermissionEntry[] | undefined;
  let agentType: string | undefined;
  let controls: ControlEntry[] | undefined;
  let bundles: string[] | undefined;
  try {
    const metaContent = await Bun.file(join(appPath, 'app.json')).text();
    const meta = JSON.parse(metaContent);
    icon = meta.icon;
    if (icon) iconType = 'emoji';
    displayName = meta.name;
    if (meta.description) description = meta.description;
    if (typeof meta.version === 'string') version = meta.version;
    if (typeof meta.author === 'string') author = meta.author;
    if (meta.createShortcut === false || meta.hidden === true) createShortcut = false;
    if (typeof meta.run === 'string') run = meta.run;
    if (meta.kind === 'system') kind = 'system';
    if (Array.isArray(meta.fileAssociations)) fileAssociations = meta.fileAssociations;
    if (meta.variant === 'widget' || meta.variant === 'panel') variant = meta.variant;
    if (meta.dockEdge === 'top' || meta.dockEdge === 'bottom') dockEdge = meta.dockEdge;
    if (meta.frameless === true) frameless = true;
    if (meta.windowStyle && typeof meta.windowStyle === 'object') windowStyle = meta.windowStyle;
    if (typeof meta.defaultWidth === 'number') defaultWidth = meta.defaultWidth;
    if (typeof meta.defaultHeight === 'number') defaultHeight = meta.defaultHeight;
    if (Array.isArray(meta.permissions)) permissions = parsePermissions(meta.permissions);
    if (typeof meta.agentType === 'string') agentType = meta.agentType;
    if (Array.isArray(meta.controls)) controls = parseControls(meta.controls);
    if (Array.isArray(meta.bundles)) {
      bundles = meta.bundles.filter((b: unknown): b is string => typeof b === 'string');
    }
  } catch {
    // No app.json or it's malformed — fields stay at their defaults.
  }

  // Only bundled apps may declare themselves `system` — an installed app cannot
  // claim protected/auto-trusted status by shipping kind:"system" in its manifest.
  if (kind === 'system' && source !== 'bundled') kind = 'app';

  // Same guard for `controls`: only bundled apps may declare authority to drive
  // other apps, so an installed app can't grab control of e.g. the real browser.
  if (controls && source !== 'bundled') controls = undefined;

  try {
    const protocolContent = await Bun.file(join(appPath, 'dist', 'protocol.json')).text();
    // Persona-audience commands are stripped here, at the one place the protocol is
    // read off disk, so every agent-facing reader downstream (`describe`, the skill
    // doc, the app agent's manifest) is filtered by construction rather than by each
    // remembering to. They are the sub-agent's half of the protocol and are described
    // to it in its own voice at spawn — see `persona-commands.ts`.
    protocol = withoutPersonaCommands(JSON.parse(protocolContent));
  } catch {
    // No protocol.json — protocol stays undefined.
  }

  // Icon image file takes priority over emoji
  try {
    const files = await readdir(appPath);
    for (const file of files) {
      const lower = file.toLowerCase();
      const dotIdx = lower.lastIndexOf('.');
      if (dotIdx === -1) continue;
      const baseName = lower.slice(0, dotIdx);
      const ext = lower.slice(dotIdx);
      if (baseName === 'icon' && ICON_IMAGE_EXTENSIONS.includes(ext)) {
        icon = `/api/apps/${appId}/${file}`;
        iconType = 'image';
        break;
      }
    }
  } catch {
    // Can't read the app dir — fall back to no icon.
  }

  const name =
    displayName ??
    appId
      .split(/[-_]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

  let resolvedRun: string | undefined;
  if (run) {
    // Absolute paths stay as-is (not a yaar:// URI)
    resolvedRun = run.startsWith('/') ? run : buildYaarUri('apps', `${appId}/${run}`);
  } else if (isCompiled) {
    resolvedRun = buildYaarUri('apps', appId);
  }

  return {
    id: appId,
    name,
    kind,
    source,
    ...(description && { description }),
    icon,
    iconType,
    ...(version && { version }),
    ...(author && { author }),
    hasConfig: appHasConfig,
    ...(createShortcut === false && { createShortcut: false }),
    ...(resolvedRun && { run: resolvedRun }),
    isCompiled,
    ...(protocol && { protocol }),
    ...(fileAssociations && { fileAssociations }),
    ...(variant && { variant }),
    ...(dockEdge && { dockEdge }),
    ...(frameless && { frameless }),
    ...(windowStyle && { windowStyle }),
    ...(defaultWidth && { defaultWidth }),
    ...(defaultHeight && { defaultHeight }),
    ...(permissions && { permissions }),
    ...(agentType && { agentType }),
    ...(controls && controls.length > 0 && { controls }),
    ...(bundles && bundles.length > 0 && { bundles }),
  };
}

// listApps() does ~5 filesystem ops per app (hasConfig, stat dist, parse
// app.json, parse protocol.json, readdir for an icon) and runs on
// every GET /api/apps, every app-agent profile build, and every describe/query
// MCP call — none of which mutate the filesystem. A short-lived cache collapses
// the repeated scans within one desktop load or one agent turn into a single
// pass. Mutations (install/uninstall/deploy/auto-compile) call
// invalidateAppsCache() so their changes show up immediately; the TTL is a
// backstop for anything not explicitly invalidated.
const APPS_CACHE_TTL_MS = 5_000;
let appsCache: { apps: AppInfo[]; at: number } | null = null;

/** Drop the cached app list so the next listApps() re-scans from disk. */
export function invalidateAppsCache(): void {
  appsCache = null;
}

/**
 * List all apps across both roots. On an id collision the bundled app wins
 * (a user-installed app cannot shadow a shipped one).
 */
export async function listApps(): Promise<AppInfo[]> {
  if (appsCache && Date.now() - appsCache.at < APPS_CACHE_TTL_MS) {
    return [...appsCache.apps]; // fresh array; callers may sort/filter in place
  }

  const byId = new Map<string, AppInfo>();

  for (const root of APP_ROOTS) {
    const source: AppSource = root === APP_ROOTS[0] ? 'bundled' : 'user';
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => compareAppIds(a.name, b.name))) {
      if (!entry.isDirectory()) continue;
      // First root (bundled) wins on id collision.
      if (byId.has(entry.name)) continue;
      byId.set(entry.name, await readAppInfo(root, entry.name, source));
    }
  }

  const apps = [...byId.values()].sort((a, b) => compareAppIds(a.id, b.id));
  appsCache = { apps, at: Date.now() };
  return [...apps];
}

export async function getAppMeta(appId: string): Promise<{
  variant?: WindowVariantType;
  dockEdge?: DockEdgeType;
  frameless?: boolean;
  windowStyle?: Record<string, string | number>;
  permissions?: PermissionEntry[];
  hasProtocol?: boolean;
  defaultWidth?: number;
  defaultHeight?: number;
  messaging?: 'all';
  controls?: ControlEntry[];
  systemApp?: boolean;
  bundles?: string[];
  streams?: string[];
  subagents?: SubAgentsEntry;
} | null> {
  const appDir = resolveAppDir(appId);
  if (!appDir) return null;
  try {
    const metaContent = await Bun.file(join(appDir, 'app.json')).text();
    const meta = JSON.parse(metaContent);
    const result: {
      variant?: WindowVariantType;
      dockEdge?: DockEdgeType;
      frameless?: boolean;
      windowStyle?: Record<string, string | number>;
      permissions?: PermissionEntry[];
      hasProtocol?: boolean;
      defaultWidth?: number;
      defaultHeight?: number;
      messaging?: 'all';
      controls?: ControlEntry[];
      systemApp?: boolean;
      bundles?: string[];
      streams?: string[];
      subagents?: SubAgentsEntry;
    } = {};
    if (meta.messaging === 'all') result.messaging = 'all';
    // Only bundled apps may be `system` (see readAppInfo) — an installed app
    // can't claim it by shipping kind:"system" in its manifest.
    if (meta.kind === 'system' && resolveAppSource(appId) === 'bundled') result.systemApp = true;
    // Only bundled apps may declare authority to drive other apps (see readAppInfo).
    if (Array.isArray(meta.controls) && resolveAppSource(appId) === 'bundled') {
      const controls = parseControls(meta.controls);
      if (controls.length > 0) result.controls = controls;
    }
    if (meta.variant === 'widget' || meta.variant === 'panel') result.variant = meta.variant;
    if (meta.dockEdge === 'top' || meta.dockEdge === 'bottom') result.dockEdge = meta.dockEdge;
    if (meta.frameless === true) result.frameless = true;
    if (meta.windowStyle && typeof meta.windowStyle === 'object')
      result.windowStyle = meta.windowStyle;
    if (typeof meta.defaultWidth === 'number') result.defaultWidth = meta.defaultWidth;
    if (typeof meta.defaultHeight === 'number') result.defaultHeight = meta.defaultHeight;
    if (Array.isArray(meta.permissions)) result.permissions = parsePermissions(meta.permissions);
    // Gated SDKs — carried onto the iframe token so the HTTP doors those SDKs open
    // can check the declaration at runtime, not just at compile time (see access.ts).
    if (Array.isArray(meta.bundles)) {
      const bundles = meta.bundles.filter((b: unknown): b is string => typeof b === 'string');
      if (bundles.length > 0) result.bundles = bundles;
    }
    // The two privileged declarations, resolved together because they answer to the
    // same rule — see `applyGrant`. A bundled manifest is taken at its word; an
    // installed one gets the intersection of what it asks for and what the user
    // approved at install (`config/app-grants.json`).
    //
    // `streams` (e.g. "agents" → may subscribe to `yaar://agents/{id}/stream`) is a
    // live agent transcript, so it may not be self-granted; it rides onto the iframe
    // token so the subscribe gate (verb.ts) checks it at runtime, not just at compile
    // time. `subagents` is how many sub-agents the app may run per
    // (monitor, app); it is gated on cost rather than secrecy — each one is a real
    // provider process holding a slot out of the global `MAX_AGENTS` semaphore — and is
    // read at spawn time rather than carried on the token, because the ceiling is a
    // per-call quota and the token is minted once per window.
    //
    // Both were bundled-*only* until market apps needed them: `chitchats` left `apps/`
    // still declaring them, and was refused with advice to add a field it already had.
    const source = resolveAppSource(appId);
    const declaredStreams = Array.isArray(meta.streams)
      ? meta.streams.filter((s: unknown): s is string => typeof s === 'string')
      : [];
    const declaredSubAgents = parseSubAgents(meta);
    // Say so once, at the one place manifests are read, rather than leaving the author
    // to discover it when a spawn fails much later.
    if (usesRetiredPersonasKey(meta)) {
      log.warn(
        'app declares "personas", which is no longer read — rename it to "subagents" in ' +
          'app.json. It cannot spawn sub-agents until then.',
        { appId },
      );
    }
    const granted = applyGrant(source, source === 'bundled' ? null : await readAppGrant(appId), {
      ...(declaredSubAgents ? { subagents: declaredSubAgents } : {}),
      ...(declaredStreams.length > 0 ? { streams: declaredStreams } : {}),
    });
    if (granted.streams) result.streams = granted.streams;
    if (granted.subagents) result.subagents = granted.subagents;
    try {
      await Bun.file(join(appDir, 'dist', 'protocol.json')).text();
      result.hasProtocol = true;
    } catch {
      // No protocol.json — hasProtocol stays unset.
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

/**
 * Read one of an app's markdown docs, or null if the app or the doc is absent.
 *
 * Both docs are optional by design — absence is the common case, not an error — so a
 * missing file and an unresolvable appId are the same `null` to every caller.
 */
async function loadAppDoc(appId: string, relPath: string): Promise<string | null> {
  const appDir = resolveAppDir(appId);
  if (!appDir) return null;
  try {
    return await Bun.file(join(appDir, relPath)).text();
  } catch {
    return null;
  }
}

/**
 * The agent docs an app may ship — read by the server, never compiled.
 *
 * Three files, three audiences, three moments:
 *
 * | file              | consumer                         | when read              |
 * |-------------------|----------------------------------|------------------------|
 * | `agent/prompt.md` | the **app agent's** system prompt | every app-agent turn  |
 * | `agent/hint.md`   | the **monitor agent's** prompt    | every monitor turn    |
 * | `agent/SKILL.md`  | whoever calls `describe`          | on demand             |
 *
 * `prompt` *is* the app agent's system prompt; `hint` is what the monitor agent is
 * told about the app; `skill` is the hand-written manual any caller can ask for. All
 * are optional, and most apps ship none.
 *
 * `skill` is deliberately not the `SKILLS/` directory proposed in
 * `docs/architecture/shell_to_userland.md` — that is a namespaced topic set reached by
 * `read`. One file returned by `describe` versus many read on demand; the two compose,
 * but the names are one letter apart and must not be confused.
 *
 * `legacy` is a root filename still read when the doc is absent at its path;
 * `retired` is one that is deliberately no longer read. `HINT.md` means nothing
 * else to anybody, so it costs nothing to keep answering to it. `AGENTS.md` means
 * something else to everybody — see {@link APP_ROOT_DOCS}.
 */
export const AGENT_DOCS = {
  prompt: { path: 'agent/prompt.md', retired: 'AGENTS.md' },
  hint: { path: 'agent/hint.md', legacy: 'HINT.md' },
  skill: { path: 'agent/SKILL.md' },
} as const satisfies Record<string, { path: string; legacy?: string; retired?: string }>;

/**
 * Docs an app keeps at its root that are *about the source*, not read by the runtime.
 *
 * `AGENTS.md` is the ecosystem's name for "instructions to a coding agent editing this
 * directory", and devtools is that agent — a non-trivial app needs somewhere to record
 * its architecture and invariants, and this is the file every other tool already looks
 * for. YAAR reads it for nothing.
 *
 * It is listed here because clone and deploy carry exactly what is named: an app root
 * holds `app.json`, the compiled `dist/`, the agent docs above, and this. A doc that
 * clone cannot see is a doc the agent editing the app cannot read, and one that deploy
 * drops is one the next clone loses — which is what happened until it was named.
 */
export const APP_ROOT_DOCS = ['AGENTS.md'] as const;

export type AgentDocKind = keyof typeof AGENT_DOCS;

/**
 * Where a manifest says its agent docs live.
 *
 * The default is `agent/{kind}.md`; `app.json`'s `"agent": { "prompt": …, "hint": … }`
 * overrides it. The override exists so the filenames stop being magic — the manifest
 * already carries every other agent knob (`agentType`, `controls`, `subagents`,
 * `bundles`), and a doc the server reads without compiling anything belongs in the
 * file the server reads.
 *
 * A traversing or absolute override is ignored rather than honored: an app.json is
 * writable by any app holding `yaar-dev`, and these paths become file reads.
 *
 * Pure, and takes the parsed manifest, because the code that *copies* the docs around
 * (clone, deploy) already has one in hand and must land on the same two paths the code
 * that *reads* them will look at — an app whose docs deployed to a path nothing reads
 * is exactly the silent-inertness this whole rename exists to avoid.
 */
export function agentDocPaths(meta: unknown): Record<AgentDocKind, string> {
  const declared = (meta as { agent?: Record<string, unknown> } | null)?.agent;
  const resolve = (kind: AgentDocKind): string => {
    const value = declared?.[kind];
    if (typeof value !== 'string' || !value) return AGENT_DOCS[kind].path;
    if (value.startsWith('/') || value.split(/[\\/]/).includes('..')) return AGENT_DOCS[kind].path;
    return value;
  };
  return { prompt: resolve('prompt'), hint: resolve('hint'), skill: resolve('skill') };
}

/**
 * The agent docs an app on disk actually keeps, in the order `AGENT_DOCS` declares them.
 *
 * Derived from the table rather than listed: this is what clone and deploy carry, and a
 * doc deploy drops is one the next clone loses — which is the failure that put
 * {@link APP_ROOT_DOCS} here in the first place. Adding a kind to `AGENT_DOCS` must be
 * enough to make it travel.
 */
export async function agentDocPathsFor(appDir: string): Promise<string[]> {
  let meta: unknown = null;
  try {
    meta = JSON.parse(await Bun.file(join(appDir, 'app.json')).text());
  } catch {
    // No app.json, or unreadable — the defaults are the answer.
  }
  const paths = agentDocPaths(meta);
  return (Object.keys(AGENT_DOCS) as AgentDocKind[]).map((kind) => paths[kind]);
}

async function resolveAgentDocPath(appId: string, kind: AgentDocKind): Promise<string> {
  const appDir = resolveAppDir(appId);
  if (!appDir) return AGENT_DOCS[kind].path;
  try {
    const meta = JSON.parse(await Bun.file(join(appDir, 'app.json')).text());
    return agentDocPaths(meta)[kind];
  } catch {
    return AGENT_DOCS[kind].path;
  }
}

/**
 * Read an app's agent doc from `agent/`, falling back to the file it used to live in
 * at the app root — except where that name has been given back.
 *
 * `HINT.md` keeps working, following the `personas` → `subagents` precedent: a rename
 * that silently turns a working app inert is the trap that one already sprang, and
 * market-installed apps ship copies we cannot migrate.
 *
 * `AGENTS.md` cannot, because it is no longer ours to read. It is the coding agent's
 * doc now ({@link APP_ROOT_DOCS}), which clone and deploy carry like any other source
 * file — so a fallback would take the architecture notes devtools just wrote for an app
 * and install them as that app's runtime persona, with the app's own agent then acting
 * on instructions addressed to whoever edits it. Keeping both readings alive is what is
 * impossible; the collision is the whole reason the prompt moved. An app that did rely
 * on it loses its prompt rather than its correctness — it falls back to the generic base
 * plus its manifest — and the notice below names the one-line fix.
 */
async function loadAgentDoc(appId: string, kind: AgentDocKind): Promise<string | null> {
  const path = await resolveAgentDocPath(appId, kind);
  const doc = await loadAppDoc(appId, path);
  if (doc !== null) return doc;

  const spec = AGENT_DOCS[kind] as { path: string; legacy?: string; retired?: string };

  if (spec.retired) {
    // Only worth saying when the app has the retired file and nothing at the new path,
    // which is exactly the ambiguous shape. An app holding both has already answered,
    // and this runs once per app agent profile — which is built once and cached.
    const retiredDoc = await loadAppDoc(appId, spec.retired);
    if (retiredDoc !== null) {
      log.warn(
        'app has a retired root agent doc and nothing at the new path. The retired file is ' +
          'the coding-agent doc and is no longer read as the app agent’s prompt — if this app ' +
          'meant it as one, copy it to the new path. If it is notes for whoever edits the app, ' +
          'nothing to do.',
        { appId, retired: spec.retired, path },
      );
    }
    return null;
  }

  if (!spec.legacy) return null;
  const legacyDoc = await loadAppDoc(appId, spec.legacy);
  if (legacyDoc !== null) {
    log.warn(
      'app still keeps its agent doc at the legacy path — the old location is read for now, ' +
        'but the app root no longer owns that name',
      { appId, legacy: spec.legacy, path },
    );
  }
  return legacyDoc;
}

/**
 * Load an app's monitor-agent hint (`agent/hint.md`).
 * When present, its content is injected into the monitor agent's system prompt
 * so the orchestrator knows when/how to use the app.
 */
export function loadAppHint(appId: string): Promise<string | null> {
  return loadAgentDoc(appId, 'hint');
}

export async function loadAllAppHints(): Promise<{ appId: string; hint: string }[]> {
  const results: { appId: string; hint: string }[] = [];
  const seen = new Set<string>();
  for (const root of APP_ROOTS) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    // Select IDs synchronously so root precedence is deterministic, then let the
    // reads run concurrently without racing to push into the shared result array.
    const appIds: string[] = [];
    for (const entry of entries.sort((a, b) => compareAppIds(a.name, b.name))) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      seen.add(entry.name);
      appIds.push(entry.name);
    }

    const hints = await Promise.all(
      appIds.map(async (appId) => {
        const hint = await loadAppHint(appId);
        return hint ? { appId, hint } : null;
      }),
    );
    for (const hint of hints) {
      if (hint) results.push(hint);
    }
  }
  return results.sort((a, b) => compareAppIds(a.appId, b.appId));
}

/**
 * Load an app's own agent prompt (`agent/prompt.md`).
 * When present, this *is* the app agent's system prompt — it replaces the generic base.
 *
 * Deliberately no longer `AGENTS.md`: that filename means "instructions to a coding
 * agent editing this directory" everywhere else, and devtools writes apps into `apps/`,
 * so the two readings collide exactly where it hurts most. The app root is now free to
 * hold the ecosystem's `AGENTS.md`.
 */
export function loadAppPrompt(appId: string): Promise<string | null> {
  return loadAgentDoc(appId, 'prompt');
}

/**
 * Load an app's hand-written manual (`agent/SKILL.md`).
 *
 * Returned by `describe('yaar://apps/{appId}')` when present, and injected into no
 * prompt — a caller asks for it, or never sees it. It is for what `protocol.json`
 * cannot say: workflows, ordering constraints, when *not* to use the app. Restating
 * command or state names the protocol already carries is what made the previous
 * SKILL.md go stale, and `scripts/check/apps.ts` warns about exactly that.
 */
export function loadAppSkill(appId: string): Promise<string | null> {
  return loadAgentDoc(appId, 'skill');
}
