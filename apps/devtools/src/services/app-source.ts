export {};
import { AppCommandError, invoke } from '@bundled/yaar';
import { setStatusText } from '../core';
import {
  base64ByteLength,
  countLines,
  protocolMap,
  searchSources,
  sliceLines,
  type ProtocolSources,
  type SourceFile,
} from '../lib';
import { writeBinaryCopy, writeFile } from './files';

// Read an installed app's source without making it a project. `cloneApp` is for editing:
// it writes a sandbox, opens it, and replaces the project in front — a heavy way to read
// one file of another app, and the session logs show it used that way (clone, read,
// deleteProject). This answers from the same server verb and writes nothing.

/** What `invoke('yaar://apps/<id>', { action: 'clone' })` answers with. */
export interface ClonePayload {
  // `encoding` is set for files whose bytes are not valid UTF-8 (images, fonts,
  // wasm). Writing those with the default utf-8 encoding re-encodes the base64
  // payload as text and corrupts the asset — see cloneAppSource.
  files: SourceFile[];
  /** The server's display triple (name, icon, description). */
  meta?: Record<string, unknown>;
  protocolSources?: ProtocolSources;
}

/** One fresh clone payload. `cloneApp` writes it into a project, so it is never cached. */
export function fetchClonePayload(appId: string): Promise<ClonePayload> {
  return invoke<ClonePayload>('yaar://apps/' + appId, { action: 'clone' });
}

/**
 * How long one fetched copy answers follow-up reads. A read of three files is three calls,
 * and each fetch carries the whole tree; a minute is long enough for a reading pass and
 * short enough that a deploy in between is soon seen.
 */
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; payload: ClonePayload }>();

async function fetchSource(appId: string): Promise<ClonePayload> {
  const hit = cache.get(appId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.payload;
  const result = await fetchClonePayload(appId);
  const payload: ClonePayload = {
    files: result?.files ?? [],
    protocolSources: result?.protocolSources,
  };
  cache.set(appId, { at: Date.now(), payload });
  return payload;
}

export interface AppSourceQuery {
  appId: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  pattern?: string;
  glob?: string;
}

function checkAppId(appId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(appId)) throw new AppCommandError(`Invalid appId: ${appId}`);
}

function findFile(appId: string, files: SourceFile[], rawPath: string): SourceFile {
  const path = rawPath.replace(/^\.?\//, '');
  const file = files.find((f) => f.path === path);
  if (file) return file;
  const near = files
    .map((f) => f.path)
    .filter((p) => p.endsWith(path.split('/').pop() ?? path))
    .slice(0, 5);
  throw new AppCommandError(
    `file not found in ${appId}: ${path}` +
      (near.length ? ` — did you mean ${near.join(', ')}?` : ''),
  );
}

/**
 * Copy one file of an installed app into the active project, byte for byte.
 *
 * The bytes come from the same clone payload readAppSource answers from, so this is
 * the read-only counterpart of `cloneApp` for one asset: no project is created, and a
 * binary file that readAppSource refuses to show as text is still reachable. Text
 * goes through writeFile so the copy records a diff; binary through writeBinaryCopy.
 */
export async function copyFromApp(
  appId: string,
  path: string,
  destination: string,
): Promise<{ from: string; bytes: number }> {
  checkAppId(appId);
  const file = findFile(appId, (await fetchSource(appId)).files, path);
  const from = `yaar://apps/${appId}/${file.path}`;
  if (file.encoding) {
    await writeBinaryCopy(destination, file.content, from);
    return { from, bytes: base64ByteLength(file.content) };
  }
  await writeFile(destination, file.content, { label: `copy from ${from}` });
  setStatusText(`Copied ${from} → ${destination}`);
  return { from, bytes: new TextEncoder().encode(file.content).length };
}

export async function readAppSource(q: AppSourceQuery): Promise<Record<string, unknown>> {
  checkAppId(q.appId);
  const { files, protocolSources } = await fetchSource(q.appId);

  if (q.path !== undefined) {
    const file = findFile(q.appId, files, q.path);
    const path = file.path;
    if (file.encoding)
      throw new AppCommandError(
        `${path} is binary and cannot be read as text. To use it, copyFile from ` +
          `"yaar://apps/${q.appId}/${path}" — it lands in the project byte for byte.`,
      );
    const lines = countLines(file.content);
    if (q.startLine === undefined && q.endLine === undefined) {
      return { appId: q.appId, path, lines, content: file.content };
    }
    const { content, from, to } = sliceLines(file.content, q.startLine, q.endLine);
    return { appId: q.appId, path, lines, range: `${from}-${to}`, content };
  }

  if (q.pattern !== undefined) {
    let found: ReturnType<typeof searchSources>;
    try {
      found = searchSources(files, q.pattern, q.glob);
    } catch (err) {
      throw new AppCommandError(`Invalid pattern: ${(err as Error).message}`);
    }
    return {
      appId: q.appId,
      matches: found.matches,
      ...(found.total > found.matches.length ? { total: found.total, truncated: true } : {}),
    };
  }

  const binary = files.some((f) => f.encoding);
  return {
    appId: q.appId,
    files: files
      .map((f) =>
        f.encoding
          ? { path: f.path, binary: true }
          : { path: f.path, lines: countLines(f.content) },
      )
      .sort((a, b) => a.path.localeCompare(b.path)),
    ...(binary
      ? {
          binaryNote:
            'binary files cannot be read as text; copyFile from ' +
            `"yaar://apps/${q.appId}/<path>" copies one into the project byte for byte.`,
        }
      : {}),
    ...(protocolSources ? { protocol: protocolMap(protocolSources) } : {}),
  };
}
