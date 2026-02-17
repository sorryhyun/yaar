/**
 * Upload image files to storage/temp/ via the storage REST API.
 */
import { apiFetch } from './api';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];

/**
 * Track whether the current drag originated from within the page.
 * dragstart only fires for in-page drags (img elements, text selections, etc.),
 * never for external file drags from the OS file manager.
 */
let _internalDragActive = false;
if (typeof document !== 'undefined') {
  document.addEventListener('dragstart', () => {
    _internalDragActive = true;
  });
  document.addEventListener('dragend', () => {
    _internalDragActive = false;
  });
}

/** Returns true if the current drag originated from outside the browser (e.g. file manager). */
export function isExternalFileDrag(): boolean {
  return !_internalDragActive;
}

/** Filter dataTransfer files to only image types. */
export function filterImageFiles(files: FileList): File[] {
  const result: File[] = [];
  for (const file of files) {
    if (IMAGE_TYPES.includes(file.type)) {
      result.push(file);
    }
  }
  return result;
}

/** Upload image files to storage/temp/, returns array of storage paths (e.g. "temp/drop-...png"). */
export async function uploadImages(files: File[]): Promise<string[]> {
  const timestamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const paths: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
    const storagePath = `temp/drop-${timestamp}-${rand}${files.length > 1 ? `-${i}` : ''}.${ext}`;

    const res = await apiFetch(`/api/storage/${storagePath}`, {
      method: 'POST',
      body: file,
    });

    if (res.ok) {
      paths.push(storagePath);
    } else {
      console.error(`Failed to upload ${file.name}:`, res.statusText);
    }
  }

  return paths;
}
