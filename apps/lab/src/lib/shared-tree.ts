import { storage } from '@bundled/yaar';
import { chartToPNG } from './chart-render';
import { dataUrlToBlob } from './data-url';
import type { ChartSpec } from '../types';

/** Normalise a caller-supplied path into the shared tree under shared/lab/. */
export function sharedPath(raw?: string, fallbackName?: string): string {
  let p = (raw || '').trim();
  if (!p) p = 'shared/lab/' + (fallbackName || 'chart-' + Date.now()) + '.png';
  if (p.startsWith('yaar://storage/')) p = p.slice('yaar://storage/'.length);
  if (p.startsWith('/')) p = p.slice(1);
  if (!p.startsWith('shared/')) p = 'shared/lab/' + p.replace(/^lab\//, '');
  if (!/\.(png|jpg|jpeg|webp)$/i.test(p)) p += '.png';
  return p;
}

/** Save a data URL into the shared tree. Returns the stored path + uri. */
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
  return await saveDataUrl(png, sharedPath(path));
}
