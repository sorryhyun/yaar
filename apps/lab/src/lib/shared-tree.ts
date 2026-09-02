import { dataUrlToBlob, storage, storagePath } from '@bundled/yaar';
import { chartToPNG } from './chart-render';
import { graphToPNG, type GraphRenderOpts } from './graph-render';
import type { ChartSpec, GraphSpec } from '../types';

/**
 * Normalise a caller-supplied path into the shared tree under shared/lab/.
 *
 * `storagePath` reads every spelling of a storage reference; what is left here is this
 * function's own rule, that anything not already naming the shared tree is *placed*
 * under `shared/lab/` rather than refused. A reference it cannot read at all — a remote
 * URL, a traversing path — falls back to a generated name for the same reason: the
 * caller asked for a chart to be saved, and refusing over the filename is not the
 * answer this is for.
 */
export function sharedPath(raw?: string, fallbackName?: string): string {
  let p = storagePath(raw) ?? '';
  if (!p) p = 'shared/lab/' + (fallbackName || 'chart-' + Date.now()) + '.png';
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

/** Same for a function graph: rendered at the spec's own viewport, saved as PNG. */
export async function saveGraph(
  spec: GraphSpec,
  path?: string,
  opts?: GraphRenderOpts,
): Promise<{ path: string; uri: string; bytes: number }> {
  const png = await graphToPNG(spec, opts);
  return await saveDataUrl(png, sharedPath(path));
}
