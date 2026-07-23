// Getting a bitmap into the app: file picker, drag-drop, clipboard paste, data URL.
import { setSourceImage, setStatus } from './state';

async function decode(blob: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  // Safari < 15 and friends: fall back to an <img> round trip.
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('could not decode the image'));
      img.src = url;
    });
    return img as unknown as ImageBitmap;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function loadBlob(blob: Blob, label = 'image'): Promise<{ w: number; h: number }> {
  if (!blob.type.startsWith('image/')) throw new Error(`${label} is not an image (${blob.type})`);
  const bitmap = await decode(blob);
  const w = bitmap.width;
  const h = bitmap.height;
  setSourceImage(bitmap, w, h);
  setStatus(`Loaded ${label} — ${w}×${h}. Drag a box over a line of text.`);
  return { w, h };
}

/**
 * Decode a `data:` URL through an `<img>`, never through `fetch`.
 *
 * The SDK replaces `window.fetch` and classifies anything whose parsed origin is
 * not this one as cross-origin — and a `data:` URL's origin is the string
 * `"null"`. So `fetch(dataUrl)` posts the entire base64 image to YAAR's HTTP
 * proxy, which rejects it without an iframe token and, with one, would ship
 * megabytes to the server to decode a local string. An `<img>` does it in-process.
 */
export async function loadDataUrl(dataUrl: string): Promise<{ w: number; h: number }> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('could not decode that image data'));
    img.src = dataUrl;
  });
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error('that image decoded to zero size');
  setSourceImage(img, w, h);
  setStatus(`Loaded image — ${w}×${h}. Drag a box over a line of text.`);
  return { w, h };
}

/** Pull the first image off a paste or drop. Returns false when there wasn't one. */
export async function loadFromDataTransfer(items: DataTransfer | null): Promise<boolean> {
  if (!items) return false;
  for (const file of Array.from(items.files)) {
    if (file.type.startsWith('image/')) {
      await loadBlob(file, file.name);
      return true;
    }
  }
  for (const item of Array.from(items.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        await loadBlob(file, file.name || 'pasted image');
        return true;
      }
    }
  }
  return false;
}

export function pickFile(): Promise<void> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) await loadBlob(file, file.name);
      resolve();
    };
    input.click();
  });
}
