/**
 * Mount configuration — expose host directories via storage/mounts/{alias}/.
 *
 * Config persisted in config/mounts.json. CRUD follows the configRead/configWrite
 * pattern from storage-manager.ts.
 */

import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { join, dirname, normalize, relative, isAbsolute } from 'path';
import { getConfigDir } from './storage-manager.js';
import { STORAGE_DIR } from '../config.js';

export interface MountEntry {
  alias: string;
  hostPath: string;
  readOnly: boolean;
  createdAt: string;
}

export interface ResolvedPath {
  absolutePath: string;
  readOnly: boolean;
}

const ALIAS_RE = /^[a-z][a-z0-9-]{0,49}$/;
const RESERVED_ALIASES = new Set(['temp', 'files', 'credentials', 'mounts']);

let cachedMounts: MountEntry[] | null = null;

function getMountsPath(): string {
  return join(getConfigDir(), 'mounts.json');
}

/**
 * Load mounts from config/mounts.json (cached after first read).
 */
export async function loadMounts(): Promise<MountEntry[]> {
  if (cachedMounts) return cachedMounts;

  try {
    const content = await readFile(getMountsPath(), 'utf-8');
    cachedMounts = JSON.parse(content) as MountEntry[];
  } catch {
    cachedMounts = [];
  }

  return cachedMounts;
}

async function persistMounts(mounts: MountEntry[]): Promise<void> {
  const filePath = getMountsPath();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(mounts, null, 2), 'utf-8');
  cachedMounts = mounts;
}

function validateAlias(alias: string): string | null {
  if (!ALIAS_RE.test(alias)) {
    return 'Alias must match /^[a-z][a-z0-9-]{0,49}$/';
  }
  if (RESERVED_ALIASES.has(alias)) {
    return `Alias "${alias}" is reserved`;
  }
  return null;
}

async function validateHostPath(hostPath: string): Promise<string | null> {
  if (!isAbsolute(hostPath)) {
    return 'Host path must be absolute';
  }

  try {
    const stats = await stat(hostPath);
    if (!stats.isDirectory()) {
      return 'Host path is not a directory';
    }
  } catch {
    return 'Host path does not exist';
  }

  // Reject paths inside STORAGE_DIR (circular mount)
  const rel = relative(STORAGE_DIR, hostPath);
  if (!rel.startsWith('..') && !isAbsolute(rel)) {
    return 'Host path must not be inside the storage directory';
  }

  return null;
}

/**
 * Add a mount. Returns null on success, error string on failure.
 */
export async function addMount(
  alias: string,
  hostPath: string,
  readOnly: boolean,
): Promise<string | null> {
  const aliasError = validateAlias(alias);
  if (aliasError) return aliasError;

  const pathError = await validateHostPath(hostPath);
  if (pathError) return pathError;

  const normalizedHostPath = normalize(hostPath);
  const mounts = await loadMounts();

  if (mounts.some((m) => m.alias === alias)) {
    return `Mount alias "${alias}" already exists`;
  }

  mounts.push({ alias, hostPath: normalizedHostPath, readOnly, createdAt: new Date().toISOString() });
  await persistMounts(mounts);
  return null;
}

/**
 * Remove a mount by alias. Returns null on success, error string on failure.
 */
export async function removeMount(alias: string): Promise<string | null> {
  const mounts = await loadMounts();
  const idx = mounts.findIndex((m) => m.alias === alias);
  if (idx === -1) return `Mount alias "${alias}" not found`;

  mounts.splice(idx, 1);
  await persistMounts(mounts);
  return null;
}

/**
 * Resolve a storage path that starts with `mounts/{alias}/...` to its host location.
 * Returns null if the path doesn't match a mount prefix.
 */
export function resolveMountPath(storagePath: string): ResolvedPath | null {
  // Normalize to handle leading/trailing slashes
  const cleaned = storagePath.replace(/^\/+/, '');
  if (!cleaned.startsWith('mounts/')) return null;

  const rest = cleaned.slice('mounts/'.length); // "alias/sub/path" or "alias"
  const slashIdx = rest.indexOf('/');
  const alias = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  const subPath = slashIdx === -1 ? '' : rest.slice(slashIdx + 1);

  if (!cachedMounts) return null;
  const mount = cachedMounts.find((m) => m.alias === alias);
  if (!mount) return null;

  // Resolve the sub-path against the host directory
  const absolutePath = normalize(subPath ? join(mount.hostPath, subPath) : mount.hostPath);

  // Ensure the resolved path stays within the mount's host directory
  const rel = relative(mount.hostPath, absolutePath);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;

  return { absolutePath, readOnly: mount.readOnly };
}
