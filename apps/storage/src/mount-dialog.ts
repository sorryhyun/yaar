export {};
import { app, storage } from '@bundled/yaar';
import { state, setState, elMountAlias, elMountHostPath, elMountReadonly } from './state';
import { basename, sanitizeAlias } from './helpers';

export function openMountDialog() {
  if (elMountAlias) elMountAlias.value = '';
  if (elMountHostPath) elMountHostPath.value = '';
  if (elMountReadonly) elMountReadonly.checked = false;
  setState('showModal', true);
  setTimeout(() => elMountAlias?.focus(), 0);
}

export function closeMountDialog() {
  setState('showModal', false);
}

export async function submitMountRequest(e: Event) {
  e.preventDefault();
  const alias = sanitizeAlias(elMountAlias.value);
  const hostPath = elMountHostPath.value.trim();
  if (!alias) { setState('statusText', 'Mount alias is required'); return; }
  if (!hostPath) { setState('statusText', 'Host folder path is required'); return; }
  if (!app?.sendInteraction) {
    setState('statusText', 'Agent bridge unavailable: cannot send mount request');
    return;
  }
  app.sendInteraction({
    event: 'storage_mount_request',
    source: 'storage',
    alias,
    hostPath,
    readOnly: elMountReadonly.checked,
  });
  closeMountDialog();
  setState('statusText', `Mount request sent for ${alias}`);
}

export async function refreshMountAliases() {
  try {
    const items = await storage.list('mounts') as unknown as import('./types').StorageEntry[];
    setState('mountAliases',
      items.filter((entry) => entry.isDirectory)
        .map((entry) => basename(entry.path))
        .sort((a, b) => a.localeCompare(b))
    );
  } catch {
    setState('mountAliases', []);
  }
}
