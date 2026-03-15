/**
 * Sandbox file operations — read, list, write, edit, delete.
 */

import { stat, unlink, mkdir, readdir } from 'fs/promises';
import { join, dirname, relative } from 'path';
import { getSandboxPath } from '../../lib/compiler/index.js';
import { generateSandboxId, isValidPath } from '../dev/helpers.js';
import {
  ok,
  okJson,
  error,
  prependNote,
  validateRelativePath,
  applyEdit,
} from '../../handlers/utils.js';
import type { VerbResult } from '../../handlers/uri-registry.js';

// ── Helpers ──

export function validateSandboxPath(path: string, sandboxPath: string): string | null {
  const pathErr = validateRelativePath(path);
  if (pathErr) return pathErr;
  if (!isValidPath(sandboxPath, path)) {
    return 'Path escapes sandbox directory.';
  }
  return null;
}

export async function listFiles(dir: string, base: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full, base)));
    } else {
      files.push(relative(base, full));
    }
  }
  return files;
}

// ── File operations ──

export async function readSandboxFile(sandboxId: string, path: string): Promise<VerbResult> {
  const sandboxPath = getSandboxPath(sandboxId);
  const pathErr = validateSandboxPath(path, sandboxPath);
  if (pathErr) return error(pathErr);

  const fullPath = join(sandboxPath, path);

  try {
    const info = await stat(fullPath);
    if (info.isDirectory()) {
      const listing = await listSandboxFiles(sandboxId, path);
      return prependNote(listing, 'This is a folder — used list instead.');
    }
    const content = await Bun.file(fullPath).text();
    const lines = content.split('\n');
    const width = String(lines.length).length;
    const numbered = lines.map((line, i) => `${String(i + 1).padStart(width)}│${line}`).join('\n');
    return ok(`── ${path} (${lines.length} lines) ──\n${numbered}`);
  } catch {
    return error(`File not found: ${path}`);
  }
}

export async function listSandboxFiles(sandboxId: string, path?: string): Promise<VerbResult> {
  const sandboxPath = getSandboxPath(sandboxId);

  try {
    const targetDir = path ? join(sandboxPath, path) : sandboxPath;
    if (path) {
      const pathErr = validateSandboxPath(path, sandboxPath);
      if (pathErr) return error(pathErr);
    }
    const files = await listFiles(targetDir, sandboxPath);
    return okJson({ sandboxId, files });
  } catch {
    return error(`Sandbox not found: ${sandboxId}`);
  }
}

export async function writeSandboxFile(
  sandboxId: string | null,
  path: string | null,
  content: unknown,
): Promise<VerbResult> {
  let resolvedId: string;
  if (sandboxId === null) {
    if (!path) return error('Provide a file path (e.g. yaar://sandbox/new/src/main.ts).');
    resolvedId = generateSandboxId();
  } else {
    if (!path) return error('Provide a file path within the sandbox.');
    resolvedId = sandboxId;
  }

  if (typeof content !== 'string') return error('"content" (string) is required for write.');

  const sandboxPath = getSandboxPath(resolvedId);
  const pathErr = validateSandboxPath(path!, sandboxPath);
  if (pathErr) return error(pathErr);

  const fullPath = join(sandboxPath, path!);
  try {
    await mkdir(dirname(fullPath), { recursive: true });
    await Bun.write(fullPath, content);
    return okJson({
      sandboxId: resolvedId,
      path,
      message: `Written to yaar://sandbox/${resolvedId}/${path}`,
    });
  } catch (err) {
    return error(err instanceof Error ? err.message : 'Unknown error');
  }
}

export async function editSandboxFile(
  sandboxId: string,
  path: string,
  payload: Record<string, unknown>,
): Promise<VerbResult> {
  const sandboxPath = getSandboxPath(sandboxId);
  const pathErr = validateSandboxPath(path, sandboxPath);
  if (pathErr) return error(pathErr);

  const fullPath = join(sandboxPath, path);
  let content: string;
  try {
    content = await Bun.file(fullPath).text();
  } catch {
    return error(`File not found: ${path}`);
  }

  const edited = await applyEdit(content, payload);
  if ('error' in edited) return error(edited.error);

  await Bun.write(fullPath, edited.result);
  return okJson({
    sandboxId,
    path,
    message: `Edited yaar://sandbox/${sandboxId}/${path}`,
  });
}

export async function deleteSandboxFile(sandboxId: string, path: string): Promise<VerbResult> {
  const sandboxPath = getSandboxPath(sandboxId);
  const pathErr = validateSandboxPath(path, sandboxPath);
  if (pathErr) return error(pathErr);

  const fullPath = join(sandboxPath, path);
  try {
    await unlink(fullPath);
    return ok(`Deleted yaar://sandbox/${sandboxId}/${path}`);
  } catch {
    return error(`File not found: ${path}`);
  }
}
