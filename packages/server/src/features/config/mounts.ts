/**
 * Config section: mounts — host directory mounts.
 */

import { z } from 'zod';
import { ok, error } from '../../handlers/utils.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { addMount, removeMount, loadMounts } from '../../storage/mounts.js';

export const mountContentSchema = z.object({
  alias: z.string(),
  hostPath: z.string(),
  readOnly: z.boolean().optional().default(false),
});

export async function handleSetMount(content: Record<string, unknown>) {
  const result = mountContentSchema.safeParse(content);
  if (!result.success) return error(`Invalid mounts content: ${result.error.message}`);

  const { alias, hostPath, readOnly } = result.data;
  const roLabel = readOnly ? ' (read-only)' : '';
  const confirmed = await actionEmitter.showPermissionDialog(
    'Mount Directory',
    `Mount "${hostPath}" as yaar://storage/mounts/${alias}/${roLabel}?`,
    'storage_mount',
    hostPath,
  );
  if (!confirmed) {
    return error('User denied the mount request.');
  }
  const err = await addMount(alias, hostPath, readOnly);
  if (err) return error(err);
  return ok(`Mounted "${hostPath}" at mounts/${alias}/`);
}

export async function handleGetMounts() {
  const mounts = await loadMounts();
  return { mounts };
}

export async function handleRemoveMount(mountAlias: string) {
  const err = await removeMount(mountAlias);
  if (err) return error(err);
  return ok(`Unmounted "${mountAlias}"`);
}
