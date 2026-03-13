/**
 * App development compile logic - compile and typecheck.
 */

import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { compileTypeScript, typecheckSandbox, getSandboxPath } from '../../lib/compiler/index.js';

export async function doCompile(
  sandboxId: string,
  options?: { title?: string },
): Promise<{ success: true; previewUrl: string } | { success: false; error: string }> {
  const sandboxPath = getSandboxPath(sandboxId);
  try {
    await stat(sandboxPath);
  } catch {
    return { success: false, error: `Sandbox "${sandboxId}" not found.` };
  }
  const result = await compileTypeScript(sandboxPath, { title: options?.title });
  if (!result.success) {
    return {
      success: false,
      error: `Compilation failed:\n${result.errors?.join('\n') ?? 'Unknown error'}`,
    };
  }
  return { success: true, previewUrl: `/api/sandbox/${sandboxId}/dist/index.html` };
}

export async function doTypecheck(
  sandboxId: string,
): Promise<{ success: true; warnings?: string[] } | { success: false; error: string }> {
  const sandboxPath = getSandboxPath(sandboxId);
  try {
    await stat(sandboxPath);
  } catch {
    return { success: false, error: `Sandbox "${sandboxId}" not found.` };
  }
  const result = await typecheckSandbox(sandboxPath);
  if (!result.success) {
    return { success: false, error: `Type check found errors:\n${result.diagnostics.join('\n')}` };
  }

  // Permission check: scan source for yaar:// URIs not covered by app.json permissions
  const permWarnings = await checkPermissions(sandboxPath);

  return { success: true, warnings: permWarnings.length > 0 ? permWarnings : undefined };
}

// ── Permission check ──

/** Known yaar:// URI prefixes that require a permission declaration. */
const PERMISSION_PREFIXES = [
  'yaar://browser/',
  'yaar://storage/',
  'yaar://apps/self/storage/',
  'yaar://config/',
  'yaar://http',
  'yaar://windows/',
];

/**
 * Scan source files for yaar:// URI usage and compare against app.json permissions.
 * Returns an array of warning strings for undeclared permissions.
 */
async function checkPermissions(sandboxPath: string): Promise<string[]> {
  // Read app.json permissions
  let declaredPermissions: string[] = [];
  try {
    const appJson = JSON.parse(await Bun.file(join(sandboxPath, 'app.json')).text());
    declaredPermissions = Array.isArray(appJson.permissions) ? appJson.permissions : [];
  } catch {
    // No app.json or invalid — treat as no permissions declared
  }

  // Collect all .ts source files
  const srcDir = join(sandboxPath, 'src');
  let sourceFiles: string[];
  try {
    sourceFiles = await collectTsFiles(srcDir);
  } catch {
    return [];
  }

  // Scan for yaar:// URI usage
  const usedPrefixes = new Set<string>();
  const uriPattern = /yaar:\/\/[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*/g;

  for (const file of sourceFiles) {
    let content: string;
    try {
      content = await Bun.file(file).text();
    } catch {
      continue;
    }

    for (const match of content.matchAll(uriPattern)) {
      const uri = match[0];
      // Find which known prefix this URI falls under
      for (const prefix of PERMISSION_PREFIXES) {
        if (uri.startsWith(prefix) || uri === prefix.replace(/\/$/, '')) {
          usedPrefixes.add(prefix);
        }
      }
    }
  }

  // Check which used prefixes are not covered by declared permissions
  const warnings: string[] = [];
  for (const prefix of usedPrefixes) {
    const covered = declaredPermissions.some(
      (perm) => prefix.startsWith(perm) || prefix === perm || perm.startsWith(prefix),
    );
    if (!covered) {
      warnings.push(
        `Permission missing: code uses "${prefix}" but app.json does not declare it in "permissions".`,
      );
    }
  }

  return warnings;
}

async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(full)));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(full);
    }
  }
  return files;
}
