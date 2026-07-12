/**
 * App discovery - list apps and load skills.
 */

import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { hasConfig } from './config.js';
import { APP_ROOTS, resolveAppDir, resolveAppSource, type AppSource } from './roots.js';
import type { AppManifest, FileAssociation } from '@yaar/shared';
import { buildYaarUri } from '@yaar/shared';
import type { PermissionEntry } from '../../http/routes/verb.js';
import type { Verb } from '../../handlers/uri-registry.js';

/** Supported image extensions for app icons */
const ICON_IMAGE_EXTENSIONS = ['.png', '.webp', '.jpg', '.jpeg', '.gif', '.svg'];

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
      const obj = entry as { appId: string; commands?: unknown };
      const parsed: ControlEntry = { appId: obj.appId };
      if (Array.isArray(obj.commands) && obj.commands.every((c) => typeof c === 'string')) {
        parsed.commands = obj.commands as string[];
      }
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
  hasSkill: boolean;
  hasConfig: boolean;
  createShortcut?: boolean;
  run?: string; // yaar:// URI for iframe content (e.g. yaar://apps/{id} or yaar://apps/{id}/dist/index.html)
  isCompiled?: boolean; // Has index.html (TypeScript compiled app)
  protocol?: Pick<AppManifest, 'state' | 'commands'>; // From protocol.json — implies appProtocol support
  fileAssociations?: FileAssociation[];
  variant?: WindowVariantType;
  dockEdge?: DockEdgeType;
  frameless?: boolean;
  windowStyle?: Record<string, string | number>;
  permissions?: PermissionEntry[];
  agentType?: string;
  /** Other apps this app may drive via the `appId` param on describe/query/command. */
  controls?: ControlEntry[];
}

/** Build an AppInfo for a single app directory under `root`. */
async function readAppInfo(root: string, appId: string, source: AppSource): Promise<AppInfo> {
  const appPath = join(root, appId);

  // Check for SKILL.md
  let hasSkill = false;
  try {
    await stat(join(appPath, 'SKILL.md'));
    hasSkill = true;
  } catch {
    // File doesn't exist
  }

  // Check for credentials (in either location)
  const appHasConfig = await hasConfig(appId);

  // Check for compiled app (index.html)
  let isCompiled = false;
  try {
    await stat(join(appPath, 'dist', 'index.html'));
    isCompiled = true;
  } catch {
    // File doesn't exist
  }

  // Check for app.json metadata
  let icon: string | undefined;
  let iconType: 'emoji' | 'image' | undefined;
  let displayName: string | undefined;
  let description: string | undefined;
  let version: string | undefined;
  let author: string | undefined;
  let createShortcut: boolean | undefined;
  let run: string | undefined;
  let kind: AppKind = 'app';
  let protocol: Pick<AppManifest, 'state' | 'commands'> | undefined;
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
  } catch {
    // No metadata or invalid JSON
  }

  // Only bundled apps may declare themselves `system` — an installed app cannot
  // claim protected/auto-trusted status by shipping kind:"system" in its manifest.
  if (kind === 'system' && source !== 'bundled') kind = 'app';

  // Same guard for `controls`: only bundled apps may declare authority to drive
  // other apps, so an installed app can't grab control of e.g. the real browser.
  if (controls && source !== 'bundled') controls = undefined;

  // Load dist/protocol.json (implies appProtocol support)
  try {
    const protocolContent = await Bun.file(join(appPath, 'dist', 'protocol.json')).text();
    protocol = JSON.parse(protocolContent);
  } catch {
    // No protocol.json
  }

  // Check for icon image file (takes priority over emoji)
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
    // Could not read directory
  }

  // Convert kebab-case or snake_case to Title Case (fallback)
  const name =
    displayName ??
    appId
      .split(/[-_]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

  // Resolve run URL as yaar:// URI
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
    hasSkill,
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
  };
}

/**
 * List all apps across both roots. On an id collision the bundled app wins
 * (a user-installed app cannot shadow a shipped one).
 */
export async function listApps(): Promise<AppInfo[]> {
  const byId = new Map<string, AppInfo>();

  for (const root of APP_ROOTS) {
    const source: AppSource = root === APP_ROOTS[0] ? 'bundled' : 'user';
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue; // root doesn't exist
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // First root (bundled) wins on id collision.
      if (byId.has(entry.name)) continue;
      byId.set(entry.name, await readAppInfo(root, entry.name, source));
    }
  }

  return [...byId.values()];
}

/**
 * Get window metadata (variant, dockEdge) for a single app from its app.json.
 */
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
    // Check for dist/protocol.json to determine appProtocol support
    try {
      await Bun.file(join(appDir, 'dist', 'protocol.json')).text();
      result.hasProtocol = true;
    } catch {
      // No dist/protocol.json
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

/**
 * Load SKILL.md for a specific app.
 */
export async function loadAppSkill(appId: string): Promise<string | null> {
  const appDir = resolveAppDir(appId);
  if (!appDir) return null;
  try {
    const content = await Bun.file(join(appDir, 'SKILL.md')).text();
    return content;
  } catch {
    return null;
  }
}

/**
 * Load HINT.md for a specific app.
 * When present, its content is injected into the monitor agent's system prompt
 * so the orchestrator knows when/how to use the app.
 */
export async function loadAppHint(appId: string): Promise<string | null> {
  const appDir = resolveAppDir(appId);
  if (!appDir) return null;
  try {
    const content = await Bun.file(join(appDir, 'HINT.md')).text();
    return content;
  } catch {
    return null;
  }
}

/**
 * Load all app hints for injection into the monitor prompt.
 */
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
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !seen.has(e.name))
        .map(async (e) => {
          seen.add(e.name);
          const hint = await loadAppHint(e.name);
          if (hint) results.push({ appId: e.name, hint });
        }),
    );
  }
  return results;
}

/**
 * Load AGENTS.md for a specific app.
 * When present, this replaces the generic app agent system prompt.
 */
export async function loadAppAgentDoc(appId: string): Promise<string | null> {
  const appDir = resolveAppDir(appId);
  if (!appDir) return null;
  try {
    const content = await Bun.file(join(appDir, 'AGENTS.md')).text();
    return content;
  } catch {
    return null;
  }
}
