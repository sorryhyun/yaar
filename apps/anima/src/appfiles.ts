// Generated images live in Anima's *app-scoped* storage
// (yaar://apps/anima/storage/generated/...), not the shared yaar://storage/ tree.
// appStorage.save() takes a string, so PNG bytes go over as base64.

import { appStorage } from '@bundled/yaar';

/** Directory inside the app storage namespace where generations are kept. */
export const GENERATED_DIR = 'generated';

export function appStorageUri(path: string): string {
  return `yaar://apps/anima/storage/${path}`;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'image';
}

/** Storage path for one generation: sortable timestamp first, so listing sorts newest-first by name. */
export function generatedPath(ratio: string, seed: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${GENERATED_DIR}/${stamp}-${safePart(ratio)}-seed${seed}.png`;
}

/** Write a PNG blob into app storage. Throws on failure. */
export async function saveImage(path: string, blob: Blob): Promise<void> {
  const base64 = await blobToBase64(blob);
  await appStorage.save(path, base64, { encoding: 'base64' });
}

export type SavedImage = {
  path: string;
  uri: string;
  name: string;
  size?: number;
  modified?: string;
};

/** List previously generated images from app storage, newest first. */
export async function listSavedImages(): Promise<SavedImage[]> {
  const entries = (await appStorage.list(GENERATED_DIR)) as unknown as Array<Record<string, unknown>>;
  return entries
    .filter((e) => String(e.name ?? e.path ?? '').endsWith('.png'))
    .map((e) => {
      const name = String(e.name ?? '');
      const path = String(e.path ?? `${GENERATED_DIR}/${name}`);
      return {
        path,
        uri: appStorageUri(path),
        name: name || path.split('/').pop() || path,
        size: typeof e.size === 'number' ? e.size : undefined,
        modified: typeof e.modified === 'string' ? e.modified : undefined,
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}
