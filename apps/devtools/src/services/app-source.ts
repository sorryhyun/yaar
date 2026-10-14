export {};
import { AppCommandError, invoke } from '@bundled/yaar';
import {
  countLines,
  groupByFile,
  searchSources,
  sliceLines,
  type ProtocolSourceLocation,
  type SourceFile,
} from '../lib';

// Read an installed app's source without making it a project. `cloneApp` is for editing:
// it writes a sandbox, opens it, and replaces the project in front — a heavy way to read
// one file of another app, and the session logs show it used that way (clone, read,
// deleteProject). This answers from the same server verb and writes nothing.

interface ClonePayload {
  files: SourceFile[];
  protocolSources?: {
    commands?: Record<string, ProtocolSourceLocation>;
    state?: Record<string, ProtocolSourceLocation>;
  };
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
  const result = await invoke<ClonePayload>(`yaar://apps/${appId}`, { action: 'clone' });
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

export async function readAppSource(q: AppSourceQuery): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z0-9._-]+$/.test(q.appId)) throw new AppCommandError(`Invalid appId: ${q.appId}`);
  const { files, protocolSources } = await fetchSource(q.appId);

  if (q.path !== undefined) {
    const path = q.path.replace(/^\.?\//, '');
    const file = files.find((f) => f.path === path);
    if (!file) {
      const near = files
        .map((f) => f.path)
        .filter((p) => p.endsWith(path.split('/').pop() ?? path))
        .slice(0, 5);
      throw new AppCommandError(
        `file not found in ${q.appId}: ${path}` +
          (near.length ? ` — did you mean ${near.join(', ')}?` : ''),
      );
    }
    if (file.encoding) {
      throw new AppCommandError(`${path} is binary (base64 in the clone payload), not text.`);
    }
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

  return {
    appId: q.appId,
    files: files
      .map((f) =>
        f.encoding
          ? { path: f.path, binary: true }
          : { path: f.path, lines: countLines(f.content) },
      )
      .sort((a, b) => a.path.localeCompare(b.path)),
    ...(protocolSources
      ? {
          protocol: {
            commands: groupByFile(protocolSources.commands ?? {}),
            state: groupByFile(protocolSources.state ?? {}),
          },
        }
      : {}),
  };
}
