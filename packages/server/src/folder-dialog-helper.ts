/**
 * The Windows folder-picker helper when running from source: `bun folder-dialog-helper.ts`.
 * The bundled exe reaches the same function through `yaar --pick-directory`
 * (`exe-bundle-entry.ts`). Spawned by `features/pick-directory.ts`.
 */
import { runFolderDialogProcess } from '@yaar/lib/win32';

runFolderDialogProcess();
