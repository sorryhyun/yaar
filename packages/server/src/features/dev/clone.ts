/**
 * Clone an app's source files for editing in devtools.
 */

import { readdir } from 'fs/promises';
import { join } from 'path';
import { PROJECT_ROOT } from '../../config.js';

interface CloneResult {
  success: boolean;
  error?: string;
  files?: { path: string; content: string }[];
  meta?: { name: string; icon: string; description: string };
}

export async function cloneAppSource(appId: string): Promise<CloneResult> {
  const appDir = join(PROJECT_ROOT, 'apps', appId);
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
  const files: { path: string; content: string }[] = [];

  // Include top-level app files so permissions, protocol, skill docs, etc. are preserved
  for (const filename of ['app.json', 'protocol.json', 'SKILL.md', 'AGENTS.md', 'HINT.md']) {
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
        const content = await Bun.file(join(srcDir, relPath)).text();
        files.push({ path: `src/${relPath}`, content });
      } catch {
        /* skip unreadable files */
      }
    }
  } catch {
    return { success: false, error: 'Failed to read source directory.' };
  }

  return { success: true, files, meta };
}
