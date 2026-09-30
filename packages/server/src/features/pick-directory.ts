/**
 * The host's native folder picker, bound to this install — the import site for
 * `@yaar/lib/pick-directory`, the way `features/pdf.ts` is for PDF.
 *
 * On Windows the dialog runs in a helper process (`@yaar/lib/win32`'s `folder-dialog.ts` says
 * why). Only the server knows how to start one: the bundled exe re-spawns itself with
 * `--pick-directory` (routed in `exe-bundle-entry.ts` before any server module loads, like
 * `--window`); from source it is the runtime plus `folder-dialog-helper.ts`.
 *
 * The deadline is `MAX_REQUEST_DEADLINE_MS`, so the dialog closes before the HTTP transport
 * gives up on the request (`config/deadlines.ts`).
 */
import { fileURLToPath } from 'node:url';
import { pickDirectory } from '@yaar/lib/pick-directory';
import { IS_BUNDLED_EXE } from '../config/env.js';
import { MAX_REQUEST_DEADLINE_MS } from '../config/deadlines.js';

export const PICK_DIRECTORY_FLAG = '--pick-directory';

function folderDialogHelperArgv(): string[] {
  if (IS_BUNDLED_EXE) return [process.execPath, PICK_DIRECTORY_FLAG];
  return [process.execPath, fileURLToPath(new URL('../folder-dialog-helper.ts', import.meta.url))];
}

export function pickHostDirectory(): Promise<string | null> {
  return pickDirectory({
    helperArgv: process.platform === 'win32' ? folderDialogHelperArgv() : undefined,
    deadlineMs: MAX_REQUEST_DEADLINE_MS,
  });
}
