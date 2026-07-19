/**
 * Clone an app's source files for editing in devtools.
 */

import { readdir } from 'fs/promises';
import { join } from 'path';
import { resolveAppDir } from '../apps/roots.js';

interface CloneFile {
  path: string;
  content: string;
  /** Present only when `content` is base64 — the file's bytes are not valid UTF-8. */
  encoding?: 'base64';
}

interface CloneResult {
  success: boolean;
  error?: string;
  files?: CloneFile[];
  meta?: { name: string; icon: string; description: string };
}

/**
 * Read a source file in whichever form survives the trip.
 *
 * `Bun.file().text()` does not throw on binary — it decodes lossily, so a PNG came
 * back as ~88k U+FFFD replacement chars and was written to the sandbox as that.
 * Cloning an app with an asset therefore corrupted the asset, and nothing failed:
 * mascot's 216KB sprite arrived as 390KB of garbage that only broke at runtime.
 * A strict UTF-8 decode is the actual question being asked — can this file be a
 * string? — so anything that fails it travels as base64 instead.
 */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

async function readCloneFile(absPath: string, relPath: string): Promise<CloneFile> {
  const bytes = await Bun.file(absPath).arrayBuffer();
  try {
    return { path: relPath, content: strictUtf8.decode(bytes) };
  } catch {
    return {
      path: relPath,
      content: Buffer.from(bytes).toString('base64'),
      encoding: 'base64',
    };
  }
}

export async function cloneAppSource(appId: string): Promise<CloneResult> {
  const appDir = resolveAppDir(appId);
  if (!appDir) return { success: false, error: `App "${appId}" not found.` };
  const srcDir = join(appDir, 'src');

  try {
    await Bun.file(join(srcDir, 'main.ts')).text();
  } catch {
    return { success: false, error: 'No source found for app. Only apps with src/ can be cloned.' };
  }

  // Read app.json for metadata
  let meta = { name: appId, icon: '', description: '' };
  try {
    const appJson = JSON.parse(await Bun.file(join(appDir, 'app.json')).text());
    meta = {
      name: appJson.name ?? appId,
      icon: appJson.icon ?? '',
      description: appJson.description ?? '',
    };
  } catch {
    /* no app.json */
  }

  // Read all source files recursively
  const files: CloneFile[] = [];

  // Include top-level app files so permissions, protocol, skill docs, etc. are preserved
  for (const filename of ['app.json', 'SKILL.md', 'AGENTS.md', 'HINT.md']) {
    try {
      const content = await Bun.file(join(appDir, filename)).text();
      if (filename.endsWith('.json')) JSON.parse(content); // validate JSON
      files.push({ path: filename, content });
    } catch {
      /* file doesn't exist or invalid */
    }
  }
  try {
    const entries = await readdir(srcDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      const relPath = entry.parentPath
        ? join(entry.parentPath, entry.name).slice(srcDir.length + 1)
        : entry.name;
      try {
        files.push(await readCloneFile(join(srcDir, relPath), `src/${relPath}`));
      } catch {
        /* skip unreadable files */
      }
    }
  } catch {
    return { success: false, error: 'Failed to read source directory.' };
  }

  return { success: true, files, meta };
}
