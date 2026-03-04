/**
 * Config section: mounts — host directory mounts.
 */

import { z } from 'zod';
import { ok, error } from '../utils.js';
import { actionEmitter } from '../action-emitter.js';
import { addMount, removeMount, loadMounts } from '../../storage/mounts.js';

export const mountSetFields = {
  alias: z
    .string()
    .optional()
    .describe('(mounts) Short name for the mount (lowercase, alphanumeric + hyphens)'),
  hostPath: z
    .string()
    .optional()
    .describe('(mounts) Absolute path to the directory on the host filesystem'),
  readOnly: z
    .boolean()
    .optional()
    .default(false)
    .describe('(mounts) If true, write and delete operations are blocked'),
};

export const mountRemoveFields = {
  mountAlias: z.string().optional().describe('The mount alias to remove'),
};

export async function handleSetMount(args: Record<string, any>) {
  if (!args.alias || !args.hostPath) {
    return error('mounts section requires alias and hostPath fields.');
  }
  const roLabel = args.readOnly ? ' (read-only)' : '';
  const confirmed = await actionEmitter.showPermissionDialog(
    'Mount Directory',
    `Mount "${args.hostPath}" as storage://mounts/${args.alias}/${roLabel}?`,
    'storage_mount',
    args.hostPath,
  );
  if (!confirmed) {
    return error('User denied the mount request.');
  }
  const err = await addMount(args.alias, args.hostPath, args.readOnly ?? false);
  if (err) return error(err);
  return ok(`Mounted "${args.hostPath}" at mounts/${args.alias}/`);
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
