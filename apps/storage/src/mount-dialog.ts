export {};
import { storage, appApi, setMountAliases, setShowModal, setStatusText, elMountAlias, elMountHostPath, elMountReadonly } from './state';
import { basename, sanitizeAlias } from './helpers';

export function openMountDialog() {
  if (elMountAlias) elMountAlias.value = '';
  if (elMountHostPath) elMountHostPath.value = '';
  if (elMountReadonly) elMountReadonly.checked = false;
  setShowModal(true);
  setTimeout(() => elMountAlias?.focus(), 0);
}

export function closeMountDialog() {
  setShowModal(false);
}

export async function submitMountRequest(e: Event) {
  e.preventDefault();
  const alias = sanitizeAlias(elMountAlias.value);
  const hostPath = elMountHostPath.value.trim();
  if (!alias) { setStatusText('Mount alias is required'); return; }
  if (!hostPath) { setStatusText('Host folder path is required'); return; }
  if (!appApi?.sendInteraction) {
    setStatusText('Agent bridge unavailable: cannot send mount request');
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
  setStatusText(`Mount request sent for ${alias}`);
}

export async function refreshMountAliases() {
  try {
    const items = await storage.list('mounts');
    setMountAliases(
      items.filter((entry) => entry.isDirectory)
        .map((entry) => basename(entry.path))
        .sort((a, b) => a.localeCompare(b))
    );
  } catch {
    setMountAliases([]);
  }
}
