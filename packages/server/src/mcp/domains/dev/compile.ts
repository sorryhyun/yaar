/**
 * App development compile logic - compile and typecheck.
 */

import { stat } from 'fs/promises';
import {
  compileTypeScript,
  typecheckSandbox,
  getSandboxPath,
} from '../../../lib/compiler/index.js';

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
): Promise<{ success: true } | { success: false; error: string }> {
  const sandboxPath = getSandboxPath(sandboxId);
  try {
    await stat(sandboxPath);
  } catch {
    return { success: false, error: `Sandbox "${sandboxId}" not found.` };
  }
  const result = await typecheckSandbox(sandboxPath);
  if (result.success) return { success: true };
  return { success: false, error: `Type check found errors:\n${result.diagnostics.join('\n')}` };
}
