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
  hasSkill: boolean;
  hasConfig: boolean;
  createShortcut?: boolean;
  run?: string; // yaar:// URI for iframe content (e.g. yaar://apps/{id} or yaar://apps/{id}/index.html)
  isCompiled?: boolean; // Has index.html (TypeScript compiled app)
  appProtocol?: boolean; // Supports App Protocol (agent ↔ iframe communication)
  protocol?: Pick<AppManifest, 'state' | 'commands'>; // Static manifest for discovery
  fileAssociations?: FileAssociation[];
  variant?: WindowVariantType;
  dockEdge?: DockEdgeType;
  frameless?: boolean;
  windowStyle?: Record<string, string | number>;
  permissions?: PermissionEntry[];
  serverActions?: Record<string, { description: string }>;
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
      let createShortcut: boolean | undefined;
      let run: string | undefined;
      let appProtocol: boolean | undefined;
      let protocol: Pick<AppManifest, 'state' | 'commands'> | undefined;
      let fileAssociations: FileAssociation[] | undefined;
      let variant: WindowVariantType | undefined;
      let dockEdge: DockEdgeType | undefined;
      let frameless: boolean | undefined;
      let windowStyle: Record<string, string | number> | undefined;
      let permissions: PermissionEntry[] | undefined;
      let serverActions: Record<string, { description: string }> | undefined;
      try {
        const metaContent = await Bun.file(join(appPath, 'app.json')).text();
        const meta = JSON.parse(metaContent);
        icon = meta.icon;
        if (icon) iconType = 'emoji';
        displayName = meta.name;
        if (meta.description) description = meta.description;
        if (meta.createShortcut === false || meta.hidden === true) createShortcut = false;
        if (typeof meta.run === 'string') run = meta.run;
        if (meta.appProtocol) appProtocol = true;
        if (meta.protocol && typeof meta.protocol === 'object') protocol = meta.protocol;
        if (Array.isArray(meta.fileAssociations)) fileAssociations = meta.fileAssociations;
        if (meta.variant === 'widget' || meta.variant === 'panel') variant = meta.variant;
        if (meta.dockEdge === 'top' || meta.dockEdge === 'bottom') dockEdge = meta.dockEdge;
        if (meta.frameless === true) frameless = true;
        if (meta.windowStyle && typeof meta.windowStyle === 'object')
          windowStyle = meta.windowStyle;
        if (Array.isArray(meta.permissions)) permissions = parsePermissions(meta.permissions);
        if (meta.serverActions && typeof meta.serverActions === 'object')
          serverActions = meta.serverActions;
      } catch {
        // No metadata or invalid JSON
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
        hasSkill,
        hasConfig: appHasConfig,
        ...(createShortcut === false && { createShortcut: false }),
        ...(resolvedRun && { run: resolvedRun }),
        isCompiled,
        ...(appProtocol && { appProtocol }),
        ...(protocol && { protocol }),
        ...(fileAssociations && { fileAssociations }),
        ...(variant && { variant }),
        ...(dockEdge && { dockEdge }),
        ...(frameless && { frameless }),
        ...(windowStyle && { windowStyle }),
        ...(permissions && { permissions }),
        ...(serverActions && { serverActions }),
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
  appProtocol?: boolean;
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
      appProtocol?: boolean;
    } = {};
    if (meta.variant === 'widget' || meta.variant === 'panel') result.variant = meta.variant;
    if (meta.dockEdge === 'top' || meta.dockEdge === 'bottom') result.dockEdge = meta.dockEdge;
    if (meta.frameless === true) result.frameless = true;
    if (meta.windowStyle && typeof meta.windowStyle === 'object')
      result.windowStyle = meta.windowStyle;
    if (Array.isArray(meta.permissions)) result.permissions = parsePermissions(meta.permissions);
    if (meta.appProtocol) result.appProtocol = true;
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
