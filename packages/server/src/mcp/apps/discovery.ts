/**
 * App discovery - list apps and load skills.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { PROJECT_ROOT } from '../../config.js';
import { hasCredentials } from './config.js';
import type { FileAssociation } from '@yaar/shared';

const APPS_DIR = join(PROJECT_ROOT, 'apps');

/** Supported image extensions for app icons */
const ICON_IMAGE_EXTENSIONS = ['.png', '.webp', '.jpg', '.jpeg', '.gif', '.svg'];

export type WindowVariantType = 'standard' | 'widget' | 'panel';
export type DockEdgeType = 'top' | 'bottom';

export interface AppInfo {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  iconType?: 'emoji' | 'image';
  hasSkill: boolean;
  hasCredentials: boolean;
  hidden?: boolean;
  isCompiled?: boolean; // Has index.html (TypeScript compiled app)
  appProtocol?: boolean; // Supports App Protocol (agent ↔ iframe communication)
  fileAssociations?: FileAssociation[];
  variant?: WindowVariantType;
  dockEdge?: DockEdgeType;
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
      const appHasCredentials = await hasCredentials(appId);

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
      let hidden: boolean | undefined;
      let appProtocol: boolean | undefined;
      let fileAssociations: FileAssociation[] | undefined;
      let variant: WindowVariantType | undefined;
      let dockEdge: DockEdgeType | undefined;
      try {
        const metaContent = await readFile(join(appPath, 'app.json'), 'utf-8');
        const meta = JSON.parse(metaContent);
        icon = meta.icon;
        if (icon) iconType = 'emoji';
        displayName = meta.name;
        if (meta.description) description = meta.description;
        if (meta.hidden) hidden = true;
        if (meta.appProtocol) appProtocol = true;
        if (Array.isArray(meta.fileAssociations)) fileAssociations = meta.fileAssociations;
        if (meta.variant === 'widget' || meta.variant === 'panel') variant = meta.variant;
        if (meta.dockEdge === 'top' || meta.dockEdge === 'bottom') dockEdge = meta.dockEdge;
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
            icon = `/api/apps/${appId}/icon`;
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

      apps.push({
        id: appId,
        name,
        ...(description && { description }),
        icon,
        iconType,
        hasSkill,
        hasCredentials: appHasCredentials,
        ...(hidden && { hidden }),
        isCompiled,
        ...(appProtocol && { appProtocol }),
        ...(fileAssociations && { fileAssociations }),
        ...(variant && { variant }),
        ...(dockEdge && { dockEdge }),
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
export async function getAppMeta(
  appId: string,
): Promise<{ variant?: WindowVariantType; dockEdge?: DockEdgeType } | null> {
  try {
    const metaContent = await readFile(join(APPS_DIR, appId, 'app.json'), 'utf-8');
    const meta = JSON.parse(metaContent);
    const result: { variant?: WindowVariantType; dockEdge?: DockEdgeType } = {};
    if (meta.variant === 'widget' || meta.variant === 'panel') result.variant = meta.variant;
    if (meta.dockEdge === 'top' || meta.dockEdge === 'bottom') result.dockEdge = meta.dockEdge;
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
    const content = await readFile(skillPath, 'utf-8');
    return content;
  } catch {
    return null;
  }
}
