/**
 * App discovery - list apps and load skills.
 */

import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { PROJECT_ROOT } from '../../config.js';
import { hasConfig } from './config.js';
import type { AppManifest, FileAssociation } from '@yaar/shared';
import { buildYaarUri } from '@yaar/shared';
import type { PermissionEntry } from '../../http/routes/verb.js';
import type { Verb } from '../../handlers/uri-registry.js';

const APPS_DIR = join(PROJECT_ROOT, 'apps');

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

export type WindowVariantType = 'standard' | 'widget' | 'panel';
export type DockEdgeType = 'top' | 'bottom';

export interface AppInfo {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  iconType?: 'emoji' | 'image';
  version?: string;
  author?: string;
  hasSkill: boolean;
  hasConfig: boolean;
  createShortcut?: boolean;
  run?: string; // yaar:// URI for iframe content (e.g. yaar://apps/{id} or yaar://apps/{id}/index.html)
  isCompiled?: boolean; // Has index.html (TypeScript compiled app)
  protocol?: Pick<AppManifest, 'state' | 'commands'>; // From protocol.json — implies appProtocol support
  fileAssociations?: FileAssociation[];
  variant?: WindowVariantType;
  dockEdge?: DockEdgeType;
  frameless?: boolean;
  windowStyle?: Record<string, string | number>;
  permissions?: PermissionEntry[];
}

/**
 * List all apps in the apps/ directory.
 */
export async function listApps(): Promise<AppInfo[]> {
  try {
    const entries = await readdir(APPS_DIR, { withFileTypes: true });
    const apps: AppInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const appId = entry.name;
      const appPath = join(APPS_DIR, appId);

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
        await stat(join(appPath, 'index.html'));
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
      let protocol: Pick<AppManifest, 'state' | 'commands'> | undefined;
      let fileAssociations: FileAssociation[] | undefined;
      let variant: WindowVariantType | undefined;
      let dockEdge: DockEdgeType | undefined;
      let frameless: boolean | undefined;
      let windowStyle: Record<string, string | number> | undefined;
      let permissions: PermissionEntry[] | undefined;
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
        if (Array.isArray(meta.fileAssociations)) fileAssociations = meta.fileAssociations;
        if (meta.variant === 'widget' || meta.variant === 'panel') variant = meta.variant;
        if (meta.dockEdge === 'top' || meta.dockEdge === 'bottom') dockEdge = meta.dockEdge;
        if (meta.frameless === true) frameless = true;
        if (meta.windowStyle && typeof meta.windowStyle === 'object')
          windowStyle = meta.windowStyle;
        if (Array.isArray(meta.permissions)) permissions = parsePermissions(meta.permissions);
      } catch {
        // No metadata or invalid JSON
      }

      // Load protocol.json (implies appProtocol support)
      try {
        const protocolContent = await Bun.file(join(appPath, 'protocol.json')).text();
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

      apps.push({
        id: appId,
        name,
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
        ...(permissions && { permissions }),
      });
    }

    return apps;
  } catch {
    // apps/ directory doesn't exist
    return [];
  }
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
} | null> {
  try {
    const metaContent = await Bun.file(join(APPS_DIR, appId, 'app.json')).text();
    const meta = JSON.parse(metaContent);
    const result: {
      variant?: WindowVariantType;
      dockEdge?: DockEdgeType;
      frameless?: boolean;
      windowStyle?: Record<string, string | number>;
      permissions?: PermissionEntry[];
      hasProtocol?: boolean;
    } = {};
    if (meta.variant === 'widget' || meta.variant === 'panel') result.variant = meta.variant;
    if (meta.dockEdge === 'top' || meta.dockEdge === 'bottom') result.dockEdge = meta.dockEdge;
    if (meta.frameless === true) result.frameless = true;
    if (meta.windowStyle && typeof meta.windowStyle === 'object')
      result.windowStyle = meta.windowStyle;
    if (Array.isArray(meta.permissions)) result.permissions = parsePermissions(meta.permissions);
    // Check for protocol.json to determine appProtocol support
    try {
      await Bun.file(join(APPS_DIR, appId, 'protocol.json')).text();
      result.hasProtocol = true;
    } catch {
      // No protocol.json
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
  try {
    const skillPath = join(APPS_DIR, appId, 'SKILL.md');
    const content = await Bun.file(skillPath).text();
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
  try {
    const hintPath = join(APPS_DIR, appId, 'HINT.md');
    const content = await Bun.file(hintPath).text();
    return content;
  } catch {
    return null;
  }
}

/**
 * Load all app hints for injection into the monitor prompt.
 */
export async function loadAllAppHints(): Promise<{ appId: string; hint: string }[]> {
  try {
    const entries = await readdir(APPS_DIR, { withFileTypes: true });
    const results: { appId: string; hint: string }[] = [];
    await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const hint = await loadAppHint(e.name);
          if (hint) results.push({ appId: e.name, hint });
        }),
    );
    return results;
  } catch {
    return [];
  }
}

/**
 * Load AGENTS.md for a specific app.
 * When present, this replaces the generic app agent system prompt.
 */
export async function loadAppAgentDoc(appId: string): Promise<string | null> {
  try {
    const agentPath = join(APPS_DIR, appId, 'AGENTS.md');
    const content = await Bun.file(agentPath).text();
    return content;
  } catch {
    return null;
  }
}
