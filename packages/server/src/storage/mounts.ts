/**
 * Mount configuration — expose host directories via storage/mounts/{alias}/.
 *
 * Config persisted in config/mounts.json. CRUD follows the configRead/configWrite
 * pattern from storage-manager.ts.
 */

import { stat } from 'fs/promises';
import { normalize, relative, isAbsolute } from 'path';
import { createPersistedStore } from './persisted-store.js';
import { STORAGE_DIR } from '../config.js';
import { containedPath, isPathWithin } from '@yaar/lib/paths';

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

const store = createPersistedStore<MountEntry[]>('mounts.json', () => []);

/**
 * Load mounts from config/mounts.json (cached after first read).
 */
export async function loadMounts(): Promise<MountEntry[]> {
  return store.read();
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
  if (isPathWithin(STORAGE_DIR, hostPath)) {
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
  const mounts = await store.read();

  if (mounts.some((m) => m.alias === alias)) {
    return `Mount alias "${alias}" already exists`;
  }

  await store.update((current) => {
    current.push({
      alias,
      hostPath: normalizedHostPath,
      readOnly,
      createdAt: new Date().toISOString(),
    });
  });
  return null;
}

/**
 * Remove a mount by alias. Returns null on success, error string on failure.
 */
export async function removeMount(alias: string): Promise<string | null> {
  const mounts = await store.read();
  const idx = mounts.findIndex((m) => m.alias === alias);
  if (idx === -1) return `Mount alias "${alias}" not found`;

  await store.update((current) => {
    current.splice(idx, 1);
  });
  return null;
}

/**
 * Resolve `mounts/{alias}/...` against its mount, keeping the entry the path landed in.
 * Returns null if the path doesn't match a mount prefix or escapes the host directory.
 */
function resolveMountEntry(
  storagePath: string,
): { mount: MountEntry; absolutePath: string } | null {
  // Normalize backslashes (Windows) and strip leading slashes
  const cleaned = storagePath.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!cleaned.startsWith('mounts/')) return null;

  const rest = cleaned.slice('mounts/'.length); // "alias/sub/path" or "alias"
  const slashIdx = rest.indexOf('/');
  const alias = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  const subPath = slashIdx === -1 ? '' : rest.slice(slashIdx + 1);

  // Synchronous by contract (callers are on hot storage paths), so this reads the
  // cache rather than loading: an unloaded store resolves nothing.
  const mount = store.peek()?.find((m) => m.alias === alias);
  if (!mount) return null;

  // Resolve the sub-path against the host directory, staying within it
  const absolutePath = containedPath(mount.hostPath, subPath);
  if (!absolutePath) return null;

  return { mount, absolutePath };
}

/**
 * Resolve a storage path that starts with `mounts/{alias}/...` to its host location.
 * Returns null if the path doesn't match a mount prefix.
 */
export function resolveMountPath(storagePath: string): ResolvedPath | null {
  const resolved = resolveMountEntry(storagePath);
  if (!resolved) return null;
  return { absolutePath: resolved.absolutePath, readOnly: resolved.mount.readOnly };
}

/**
 * The alias whose *root* a storage path names — null for anything else, including a
 * path inside a mount and a path outside `mounts/` entirely.
 *
 * A mount root is the one storage path that is not storage: it *is* the user's host
 * directory, so a caller about to do something irreversible needs to tell the two
 * apart. The test compares the resolved path against the host directory rather than
 * asking whether the sub-path string is empty, so every spelling that lands on the
 * root — `mounts/docs`, `mounts/docs/`, `mounts/docs/.`, `mounts/docs/sub/..` —
 * answers the same way.
 */
export function mountRootAlias(storagePath: string): string | null {
  const resolved = resolveMountEntry(storagePath);
  if (!resolved) return null;
  return relative(resolved.mount.hostPath, resolved.absolutePath) === ''
    ? resolved.mount.alias
    : null;
}

/**
 * Override the cached mounts for testing. Pass null to reset.
 * @internal — only for use in test files.
 */
export const _setMountsForTest = store._setForTest;
