export {};
import type { StorageEntry } from './types';

// Access the injected verb API
const v = () => (window as unknown as { yaar: { invoke: Function; read: Function; list: Function; delete: Function } }).yaar;

/** Build a yaar://storage/ URI from a relative path */
export function storageUri(path: string): string {
  const clean = path ? path.replace(/^\//, '') : '';
  return clean ? `yaar://storage/${clean}` : 'yaar://storage/';
}

/** Direct URL for browser access (images, downloads, etc.) */
export function storageUrl(path: string): string {
  return `/api/storage/${path}`;
}

/** List directory contents */
export async function storageList(path: string): Promise<StorageEntry[]> {
  const result = await v().list(storageUri(path));
  const raw = result.content[0]?.text ?? '[]';
  return JSON.parse(raw) as StorageEntry[];
}

/** Read a file as text */
export async function storageRead(path: string): Promise<string> {
  const result = await v().read(storageUri(path));
  return result.content[0]?.text ?? '';
}

/** Write a file (text or binary ArrayBuffer) */
export async function storageSave(path: string, content: string | ArrayBuffer): Promise<void> {
  if (content instanceof ArrayBuffer) {
    // Use REST API for raw binary uploads
    const res = await fetch(`/api/storage/${path}`, { method: 'POST', body: new Blob([content]) });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  } else {
    await v().invoke(storageUri(path), { action: 'write', content });
  }
}

/** Delete a file or directory */
export async function storageDelete(path: string): Promise<void> {
  await v().delete(storageUri(path));
}
