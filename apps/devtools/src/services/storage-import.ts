export {};
import { appStorage, errMsg, invoke, storage, storagePath, toWebP } from '@bundled/yaar';
import { activeProject, setStatusText, setTypecheckState } from '../core';
import { projectPath } from '../lib';
import { recordChange } from './changes';
import { refreshFiles } from './files';

// Moving a file between the storage tree and the active project, in both directions.
//
// The bytes never enter a model context, and with no recompression they never enter
// this iframe either: `action: 'copy'` moves them storage -> storage on the server.
// Only a recompress round-trips them here to be re-encoded. That is the reason this
// is a command rather than advice to read the file and write it back — a base64 blob
// in a transcript is the failure mode being designed out.
//
// The export direction (`exportToStorage`) is the same argument run backwards, and it
// was missing: a project could take in an artifact another app had published and had
// no way to hand one back, so a scene document another app needed to open had to be
// read into an agent's context and written out again. The two directions now differ
// only in which side of the copy names the project.

/** Formats worth re-encoding. WebP and SVG are already what we would convert to. */
const RECOMPRESSIBLE = new Set(['png', 'jpg', 'jpeg', 'bmp']);

/**
 * Inlined assets land in the bundle as base64, which costs ~33% on top of the raw
 * bytes. Past this the editor round-trips on a multi-MB `index.html` get unpleasant
 * and a runtime fetch from the app's own storage is the better shape.
 */
export const SIZE_WARN_BYTES = 1_000_000;

export interface StorageImport {
  path: string;
  bytes: number;
  recompressed: boolean;
}

interface StorageEntry {
  path: string;
  isDirectory: boolean;
  size?: number;
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

function extOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? '';
}

/** The file name a storage source lands under when no destination was given. */
export function defaultAssetPath(sourcePath: string): string {
  return `src/assets/${baseName(sourcePath)}`;
}

/**
 * Whether a `from` names the storage tree rather than a file in the project.
 *
 * The test is the `yaar://` scheme and nothing looser. `storagePath` accepts four
 * dialects — including a bare `shared/anima/dragon.png` — and a project may hold a
 * file at any of those spellings, so a looser test would let storage shadow the
 * project's own files depending on what happened to exist. An explicit scheme keeps
 * the two namespaces from ever overlapping.
 */
export function isStorageRef(ref: string): boolean {
  return ref.startsWith('yaar://');
}

/** A `yaar://` reference reduced to a storage-root-relative path. */
export function resolveStorageSource(ref: string): string {
  const path = storagePath(ref);
  if (path === null) {
    throw new Error(`"${ref}" is not a file in storage. Expected a yaar://storage/... path.`);
  }
  return path;
}

/** Whether this source is a raster format a WebP re-encode could shrink. */
export function isRecompressible(sourcePath: string): boolean {
  return RECOMPRESSIBLE.has(extOf(sourcePath));
}

/** The source's size on disk, or null if it cannot be determined. */
async function sourceSize(sourcePath: string): Promise<number | null> {
  const dir = sourcePath.split('/').slice(0, -1).join('/');
  try {
    const entries = ((await storage.list(dir)) ?? []) as unknown as StorageEntry[];
    return entries.find((e) => e.path === sourcePath)?.size ?? null;
  } catch {
    return null;
  }
}

/**
 * Read a storage file and re-encode it to WebP.
 *
 * The canvas round-trip itself is `toWebP` from the SDK; this is the storage read in
 * front of it. Null (from either half) means the browser could not decode or encode
 * the file — a corrupt source, or an encoder that declined — so the caller falls back
 * to copying the original rather than failing the import.
 */
async function recompressToWebP(
  sourcePath: string,
): Promise<{ base64: string; bytes: number } | null> {
  try {
    const blob = (await storage.read(sourcePath, { as: 'blob' })) as Blob;
    return await toWebP(blob, { quality: 0.9 });
  } catch {
    return null;
  }
}

/**
 * Server-side copy: the bytes go storage -> storage without passing through this
 * iframe. `from` is checked against this app's read permissions at the verb door,
 * the same as reading it directly would be.
 */
async function copyIntoProject(
  projectId: string,
  sourcePath: string,
  destination: string,
): Promise<number> {
  const result = await invoke<string>(
    `yaar://apps/self/storage/${projectPath(projectId, destination)}`,
    { action: 'copy', from: `yaar://storage/${sourcePath}` },
  );
  // The handler reports "… (N bytes)"; fall back to the listing if that changes.
  const match = typeof result === 'string' ? result.match(/\((\d+) bytes\)/) : null;
  return match ? Number(match[1]) : ((await sourceSize(sourcePath)) ?? 0);
}

/**
 * Copy a file out of the active project into the storage tree.
 *
 * The mirror of `copyFromStorage`, and server-side for the same reason: the bytes go
 * storage -> storage without passing through this iframe or anyone's transcript.
 * There is no recompression on the way out — an export is what the project holds,
 * byte for byte, because the receiving app is about to parse it.
 *
 * The source names the project's own tree as `yaar://apps/self/storage/…`. `self` is
 * expanded at the verb door (`handlers/storage-copy.ts` server-side), which is what
 * makes this direction reachable at all: an app's own storage has no other spelling
 * a copy source can use.
 */
export async function exportToStorage(
  sourcePath: string,
  destination: string,
): Promise<{ uri: string; bytes: number }> {
  const proj = activeProject();
  if (!proj) throw new Error('No active project. Open or create one first.');

  const uri = `yaar://storage/${destination}`;
  let result: string;
  try {
    result = await invoke<string>(uri, {
      action: 'copy',
      from: `yaar://apps/self/storage/${projectPath(proj.id, sourcePath)}`,
    });
  } catch (err) {
    throw new Error(`Could not export ${sourcePath}: ${errMsg(err)}`);
  }

  // The handler reports "… (N bytes)"; a changed wording costs the count, not the copy.
  const match = typeof result === 'string' ? result.match(/\((\d+) bytes\)/) : null;
  const bytes = match ? Number(match[1]) : 0;

  // Nothing in the project changed, so no `recordChange` and no `refreshFiles` — the
  // status line is the whole of the feedback an export owes the user.
  setStatusText(`Exported ${sourcePath} to ${uri}`);
  return { uri, bytes };
}

/**
 * Copy a storage file into the active project.
 *
 * `recompress` defaults to on for raster formats, and the WebP is kept only if it
 * actually won: a small PNG with few colours can re-encode *larger*, and paying that
 * in the bundle to no benefit is worse than keeping the original. `renameToWebP` is
 * set only when the caller did not name a destination — an explicit `to` is honoured
 * as written, extension included.
 */
export async function copyFromStorage(
  sourcePath: string,
  destination: string,
  opts: { recompress?: boolean; renameToWebP?: boolean } = {},
): Promise<StorageImport> {
  const proj = activeProject();
  if (!proj) throw new Error('No active project. Open or create one first.');

  const wantsRecompress = opts.recompress !== false && isRecompressible(sourcePath);
  let path = destination;
  let bytes: number;
  let recompressed = false;

  try {
    const encoded = wantsRecompress ? await recompressToWebP(sourcePath) : null;
    const originalSize = encoded ? await sourceSize(sourcePath) : null;
    if (encoded && (originalSize === null || encoded.bytes < originalSize)) {
      if (opts.renameToWebP) path = path.replace(/\.[^.]+$/, '.webp');
      // `appStorage`, not `storage` — the project lives in devtools' own app-scoped
      // tree, and the flat SDK would resolve the same path against the storage root.
      await appStorage.save(projectPath(proj.id, path), encoded.base64, { encoding: 'base64' });
      bytes = encoded.bytes;
      recompressed = true;
    } else {
      bytes = await copyIntoProject(proj.id, sourcePath, path);
    }
  } catch (err) {
    throw new Error(`Could not copy ${sourcePath}: ${errMsg(err)}`);
  }

  // An imported file is a new module in the program, so the last typecheck verdict no
  // longer covers it — the same reset every other mutation performs.
  setTypecheckState('unknown');
  // Recorded as the fact rather than the content: an asset is bytes, and a diff of
  // decoded binary tells the reader nothing. Without this the Changes panel would be
  // silent about a file appearing in the tree, which is the state that panel exists
  // to end.
  recordChange({
    path,
    kind: 'create',
    before: '',
    after: `(imported from yaar://storage/${sourcePath}: ${bytes} bytes)`,
    label: recompressed ? 'import (WebP)' : 'import',
  });
  await refreshFiles();
  setStatusText(`Imported ${path}`);
  return { path, bytes, recompressed };
}
