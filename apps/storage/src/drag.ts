export {};
import type { StorageEntry } from './types';
import { appApi, setStatusText } from './state';
import { basename, getExtension, buildDragMetadata } from './helpers';

export function safeSetDragData(dt: DataTransfer, type: string, value: string) {
  try { dt.setData(type, value); } catch { /* ignore */ }
}

export function requestOpenByAgent(entry: StorageEntry) {
  if (!appApi?.sendInteraction) return;
  const name = basename(entry.path);
  const extension = getExtension(name);
  appApi.sendInteraction({
    event: 'open_file_request',
    source: 'storage',
    path: entry.path,
    name,
    extension,
    isDirectory: entry.isDirectory,
  });
  setStatusText(`Requested agent open: ${name}`);
}

export function handleDragStart(e: DragEvent, entry: StorageEntry) {
  const dt = e.dataTransfer;
  if (!dt) return;
  const metadata = buildDragMetadata(entry);
  const uriList = [metadata.url, metadata.storageUri].filter(Boolean).join('\n');
  dt.effectAllowed = 'copyMove';
  safeSetDragData(dt, 'text/plain', `${metadata.path}\n${metadata.name}`);
  safeSetDragData(dt, 'text/uri-list', uriList);
  safeSetDragData(dt, 'application/json', JSON.stringify(metadata));
  safeSetDragData(dt, 'application/x-yaar-storage-item+json', JSON.stringify(metadata));
  (e.currentTarget as HTMLElement).classList.add('dragging');
}

export function handleDragEnd(e: DragEvent) {
  (e.currentTarget as HTMLElement).classList.remove('dragging');
}
