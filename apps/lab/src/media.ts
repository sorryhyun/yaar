import { storage } from '@bundled/yaar';
import { chartToPNG } from './chart';
import type { ChartSpec } from './types';

export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const head = dataUrl.slice(0, comma);
  const mime = /data:([^;,]+)/.exec(head)?.[1] || 'application/octet-stream';
  const body = dataUrl.slice(comma + 1);
  if (head.includes(';base64')) {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(body)], { type: mime });
}

/** Normalise a caller-supplied path into the shared media tree under media/lab/. */
export function mediaPath(raw?: string, fallbackName?: string): string {
  let p = (raw || '').trim();
  if (!p) p = 'media/lab/' + (fallbackName || 'chart-' + Date.now()) + '.png';
  if (p.startsWith('yaar://storage/')) p = p.slice('yaar://storage/'.length);
  if (p.startsWith('/')) p = p.slice(1);
  if (!p.startsWith('media/')) p = 'media/lab/' + p.replace(/^lab\//, '');
  if (!/\.(png|jpg|jpeg|webp)$/i.test(p)) p += '.png';
  return p;
}

/** Save a data URL into the shared media tree. Returns the stored path + uri. */
export async function saveDataUrl(
  dataUrl: string,
  path: string,
): Promise<{ path: string; uri: string; bytes: number }> {
  const blob = dataUrlToBlob(dataUrl);
  await storage.save(path, blob);
  return { path, uri: 'yaar://storage/' + path, bytes: blob.size };
}

export async function saveChart(
  spec: ChartSpec,
  path?: string,
  opts?: { width?: number; height?: number; scale?: number; background?: string },
): Promise<{ path: string; uri: string; bytes: number }> {
  const png = await chartToPNG(spec, opts);
  return await saveDataUrl(png, mediaPath(path));
}

/** Browser download of a data URL, for the in-app save button. */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
