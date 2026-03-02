export {};
import { storage, appApi, mountAliases, showModal, statusText, elMountAlias, elMountHostPath, elMountReadonly } from './state';
import { basename, sanitizeAlias } from './helpers';

export function openMountDialog() {
  if (elMountAlias) elMountAlias.value = '';
  if (elMountHostPath) elMountHostPath.value = '';
  if (elMountReadonly) elMountReadonly.checked = false;
  showModal(true);
  setTimeout(() => elMountAlias?.focus(), 0);
}

export function closeMountDialog() {
  showModal(false);
}

export async function submitMountRequest(e: Event) {
  e.preventDefault();
  const alias = sanitizeAlias(elMountAlias.value);
  const hostPath = elMountHostPath.value.trim();
  if (!alias) { statusText('Mount alias is required'); return; }
  if (!hostPath) { statusText('Host folder path is required'); return; }
  if (!appApi?.sendInteraction) {
    statusText('Agent bridge unavailable: cannot send mount request');
    return;
  }
  appApi.sendInteraction({
    event: 'storage_mount_request',
    source: 'storage',
    alias,
    hostPath,
    readOnly: elMountReadonly.checked,
  });
  closeMountDialog();
  statusText(`Mount request sent for ${alias}`);
}

export async function refreshMountAliases() {
  try {
    const items = await storage.list('mounts');
    mountAliases(
      items.filter((entry) => entry.isDirectory)
        .map((entry) => basename(entry.path))
        .sort((a, b) => a.localeCompare(b))
    );
  } catch {
    mountAliases([]);
  }
}
