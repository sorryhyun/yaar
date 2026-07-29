/**
 * loaders/index.ts — format detection (extension + magic bytes) and dispatch.
 */
import { loadSTL } from './stl';
import { loadOBJ } from './obj';
import { loadGLTF, isGLB } from './glb';
import type { LoadOptions, LoadResult, ModelFormat } from './types';

export { UnsupportedGltfError } from './glb';
export type { LoadResult, LoadOptions, ModelFormat, ResourceResolver } from './types';

export const SUPPORTED_EXTENSIONS = ['.glb', '.gltf', '.obj', '.stl', '.scene.json'];

function extensionOf(name: string): string {
  const lower = name.toLowerCase().split(/[?#]/)[0];
  if (lower.endsWith('.scene.json')) return '.scene.json';
  const dot = lower.lastIndexOf('.');
  return dot < 0 ? '' : lower.slice(dot);
}

function sniff(buf: ArrayBuffer): ModelFormat | null {
  if (buf.byteLength < 8) return null;
  if (isGLB(buf)) return 'glb';

  const view = new DataView(buf);
  // binary STL: 80-byte header + uint32 count + 50 bytes per triangle
  if (buf.byteLength >= 84) {
    const tris = view.getUint32(80, true);
    if (tris > 0 && 84 + tris * 50 === buf.byteLength) return 'stl';
  }

  const head = new TextDecoder()
    .decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 1024)))
    .trimStart();
  if (head.startsWith('{')) {
    if (/"asset"\s*:/.test(head) || /"scenes"\s*:/.test(head)) return 'gltf';
    if (/"root"\s*:/.test(head) || /"version"\s*:\s*1/.test(head)) return 'scene';
    return 'gltf';
  }
  if (/^solid\b/i.test(head)) return 'stl';
  if (/^\s*(v|vn|vt|f|o|g|mtllib|usemtl)\s/m.test(head)) return 'obj';
  return null;
}

export function detectFormat(name: string, buf: ArrayBuffer): ModelFormat | null {
  const byMagic = sniff(buf);
  if (byMagic) return byMagic;
  switch (extensionOf(name)) {
    case '.glb':
      return 'glb';
    case '.gltf':
      return 'gltf';
    case '.obj':
      return 'obj';
    case '.stl':
      return 'stl';
    case '.scene.json':
      return 'scene';
    default:
      return null;
  }
}

export function isSupportedName(name: string): boolean {
  const ext = extensionOf(name);
  return SUPPORTED_EXTENSIONS.includes(ext);
}

export async function loadModelBuffer(
  buf: ArrayBuffer,
  opts: LoadOptions,
): Promise<LoadResult & { format: ModelFormat }> {
  const format = detectFormat(opts.name, buf);
  if (!format) {
    throw new Error(
      `Could not identify "${opts.name}". 3D Studio reads ${SUPPORTED_EXTENSIONS.join(', ')}.`,
    );
  }
  if (format === 'scene') {
    throw new Error('SCENE_DOC'); // handled by the caller — not a three.js import
  }
  if (format === 'stl') return { ...loadSTL(buf, opts.name), format };
  if (format === 'obj') return { ...(await loadOBJ(buf, opts)), format };
  return { ...(await loadGLTF(buf, opts)), format };
}
