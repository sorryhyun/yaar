/**
 * Shared-tree discovery and asset import.
 *
 * `storage/shared/` is the shared tree where apps publish artifacts for each other —
 * an image generated in anima, an edit from image-edit, a dataset lab computed. These
 * two commands are how a project picks one up.
 *
 * They run **in the iframe**, not as agent tools, and that is the whole design. The
 * app agent has `describe`/`query`/`command`/`relay` and no verb tools at all; its
 * storage is confined to its own window's app. It cannot reach `shared/` itself and
 * gains no ability to here — it asks this app to do what this app's declared,
 * user-visible `yaar://storage/` permission already allows, through a named
 * command that shows up in `dist/protocol.json`. Same shape as compile and deploy:
 * the agent does not hold `yaar-dev`, the iframe does.
 *
 * The other half of the design is that the bytes never enter a model context. An
 * import with no recompression is a server-side `copy` — the file never touches this
 * iframe either. With recompression the bytes come here, get re-encoded, and go back
 * as base64. Neither path puts them in a transcript.
 */

import {
  AppCommandError,
  appStorage,
  errMsg,
  invoke,
  storage,
  toWebP,
  defineAppCommand,
} from '@bundled/yaar';
import { activeProject } from '../core';
import { projectPath } from '../lib';
import { refreshFiles } from '../services';

/** The shared tree. Everything here is relative to the flat storage root. */
const SHARED_ROOT = 'shared';

/**
 * Inlined assets land in the bundle as base64, which costs ~33% on top of the raw
 * bytes. Past this the editor round-trips on a multi-MB `index.html` get unpleasant
 * and a runtime fetch from the app's own storage is the better shape.
 */
const SIZE_WARN_BYTES = 1_000_000;

/** Formats worth re-encoding. WebP and SVG are already what we would convert to. */
const RECOMPRESSIBLE = new Set(['png', 'jpg', 'jpeg', 'bmp']);

interface SharedEntry {
  path: string;
  isDirectory: boolean;
  size?: number;
}

function extOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? '';
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * Accept either spelling of a shared-tree reference and return its storage path.
 *
 * The agent will have got the URI from `listShared`, but a user relaying it by hand
 * says "shared/anima/dragon.png" as often as the full URI, and a producer's publish
 * confirmation may say either.
 */
function sharedPathFrom(raw: string): string {
  let path = raw.trim();
  if (path.startsWith('yaar://storage/')) path = path.slice('yaar://storage/'.length);
  path = path.replace(/^\/+/, '');
  if (!path.startsWith(`${SHARED_ROOT}/`) && path !== SHARED_ROOT) path = `${SHARED_ROOT}/${path}`;
  if (path.split('/').includes('..')) {
    throw new AppCommandError(`"${raw}" is not a path under ${SHARED_ROOT}/`);
  }
  return path;
}

/**
 * One level of listing, as entries with their sizes.
 *
 * Dotfiles are dropped. The shared tree is a real directory on someone's machine, so
 * the OS leaves its own files in it — a macOS `.DS_Store` was listed as a published
 * artifact whose producer was `.DS_Store`, which is a file nothing published and
 * nothing can import.
 */
async function listDir(path: string): Promise<SharedEntry[]> {
  try {
    const entries = ((await storage.list(path)) ?? []) as unknown as SharedEntry[];
    return entries.filter((e) => !baseName(e.path).startsWith('.'));
  } catch {
    // A missing `shared/` is the ordinary state before anything has been published,
    // not an error worth failing the command over.
    return [];
  }
}

export const sharedCommands = {
  listShared: defineAppCommand({
    description:
      'List artifacts other apps have published to the shared tree ' +
      '(yaar://storage/shared/), keyed by producer app. Pass `prefix` to look inside one ' +
      'producer, e.g. "anima". Empty result means nothing has been published yet.',
    params: {
      type: 'object',
      properties: {
        prefix: {
          type: 'string',
          description: 'Sub-path under shared/ to list, e.g. "anima". Omit for everything.',
        },
      },
    },
    run: async (p) => {
      const prefix = p.prefix ? sharedPathFrom(String(p.prefix)) : SHARED_ROOT;
      const top = await listDir(prefix);

      // shared/ itself holds one directory per producer, so a bare listing shows only
      // folder names — useless for picking a file. Descend one level.
      const files: SharedEntry[] = [];
      for (const entry of top) {
        if (!entry.isDirectory) {
          files.push(entry);
          continue;
        }
        files.push(...(await listDir(entry.path)).filter((e) => !e.isDirectory));
      }

      return {
        prefix,
        count: files.length,
        files: files.map((f) => ({
          uri: `yaar://storage/${f.path}`,
          name: baseName(f.path),
          producer: f.path.split('/')[1] ?? null,
          bytes: f.size ?? null,
        })),
      };
    },
  }),

  importAsset: defineAppCommand({
    description:
      'Copy a file from the shared tree (yaar://storage/shared/) into the active ' +
      'project as a build-time asset, under src/assets/ by default. Returns the import line ' +
      'to add; the bundler inlines the file as a data: URI. Raster images are re-encoded to ' +
      'WebP unless `recompress: false`.',
    params: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description:
            'Source in the shared tree — a yaar://storage/shared/… URI from listShared, or a ' +
            'path like "anima/dragon.png".',
        },
        to: {
          type: 'string',
          description: 'Destination path within the project. Defaults to src/assets/<source name>.',
        },
        recompress: {
          type: 'boolean',
          description:
            'Re-encode raster images to WebP (default true). Set false to keep the original ' +
            'bytes exactly — needed for SVG, GIF animation, or anything lossless.',
        },
      },
      required: ['from'],
    },
    run: async (p) => {
      const proj = activeProject();
      if (!proj) throw new AppCommandError('No active project. Open or create one first.');

      const sourcePath = sharedPathFrom(String(p.from));
      const sourceExt = extOf(sourcePath);
      const wantsRecompress = p.recompress !== false && RECOMPRESSIBLE.has(sourceExt);

      let destination = p.to
        ? String(p.to).replace(/^\/+/, '')
        : `src/assets/${baseName(sourcePath)}`;
      if (destination.split('/').includes('..')) {
        throw new AppCommandError(`Destination "${destination}" escapes the project.`);
      }

      let bytes: number;
      let recompressed = false;

      if (wantsRecompress) {
        const encoded = await recompressToWebP(sourcePath);
        if (encoded) {
          // Only take the WebP if it actually won. A small PNG with few colours can
          // re-encode *larger*, and paying that in the bundle to no benefit is worse
          // than keeping the original.
          const originalSize = await sourceSize(sourcePath);
          if (originalSize === null || encoded.bytes < originalSize) {
            if (!p.to) destination = destination.replace(/\.[^.]+$/, '.webp');
            // `appStorage`, not `storage` — the project lives in devtools' own
            // app-scoped tree, and the flat SDK would resolve the same path against
            // the storage root.
            await appStorage.save(projectPath(proj.id, destination), encoded.base64, {
              encoding: 'base64',
            });
            bytes = encoded.bytes;
            recompressed = true;
          } else {
            bytes = await copyIntoProject(proj.id, sourcePath, destination);
          }
        } else {
          bytes = await copyIntoProject(proj.id, sourcePath, destination);
        }
      } else {
        bytes = await copyIntoProject(proj.id, sourcePath, destination);
      }

      await refreshFiles();

      // The path an `import` sees is relative to the importing file. src/assets/x.webp
      // from src/main.ts is './assets/x.webp'.
      const fromSrc = destination.replace(/^src\//, './');
      const varName =
        baseName(destination)
          .replace(/\.[^.]+$/, '')
          .replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase())
          .replace(/^[^a-zA-Z_$]+/, '') || 'asset';

      return {
        path: destination,
        bytes,
        recompressed,
        importLine: `import ${varName} from '${fromSrc}';`,
        ...(bytes > SIZE_WARN_BYTES
          ? {
              warning:
                `${destination} is ${Math.round(bytes / 1000)}KB and will be inlined as base64 ` +
                `(~${Math.round((bytes * 1.33) / 1000)}KB in the bundle). Consider a smaller ` +
                `source, or deploying the file to the app's own storage and fetching it at runtime.`,
            }
          : {}),
      };
    },
  }),
};

/** The source's size on disk, or null if it cannot be determined. */
async function sourceSize(sourcePath: string): Promise<number | null> {
  const dir = sourcePath.split('/').slice(0, -1).join('/');
  const entries = await listDir(dir);
  return entries.find((e) => e.path === sourcePath)?.size ?? null;
}

/**
 * Server-side copy: the bytes go storage → storage without passing through this
 * iframe. `from` is checked against this app's read permissions at the verb door,
 * the same as reading it directly would be.
 */
async function copyIntoProject(
  projectId: string,
  sourcePath: string,
  destination: string,
): Promise<number> {
  try {
    const result = await invoke<string>(
      `yaar://apps/self/storage/${projectPath(projectId, destination)}`,
      { action: 'copy', from: `yaar://storage/${sourcePath}` },
    );
    // The handler reports "… (N bytes)"; fall back to the listing if that changes.
    const match = typeof result === 'string' ? result.match(/\((\d+) bytes\)/) : null;
    return match ? Number(match[1]) : ((await sourceSize(sourcePath)) ?? 0);
  } catch (err) {
    throw new AppCommandError(`Could not import ${sourcePath}: ${errMsg(err)}`);
  }
}

/**
 * Read a shared-tree file and re-encode it to WebP.
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

