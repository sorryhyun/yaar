/**
 * registry.ts — the side table for GPU resources the scene doc only references.
 *
 * The doc is plain JSON, so imported vertex buffers and textures live here and
 * are addressed by an opaque ref string. `sweep()` disposes anything the doc no
 * longer references — that is the whole GPU-leak story for imports.
 */
import * as THREE from '@bundled/three';

const geometries = new Map<string, THREE.BufferGeometry>();
const textures = new Map<string, THREE.Texture>();

let seq = 0;
function nextRef(prefix: string): string {
  seq += 1;
  return `${prefix}:${seq.toString(36)}`;
}

export function putGeometry(geo: THREE.BufferGeometry): string {
  const ref = nextRef('geo');
  geometries.set(ref, geo);
  return ref;
}

export function getGeometry(ref: string | undefined): THREE.BufferGeometry | undefined {
  return ref ? geometries.get(ref) : undefined;
}

export function putTexture(tex: THREE.Texture): string {
  const ref = nextRef('tex');
  textures.set(ref, tex);
  return ref;
}

export function getTexture(ref: string | undefined): THREE.Texture | undefined {
  return ref ? textures.get(ref) : undefined;
}

/** Vertex / triangle counts for a registered buffer geometry. */
export function geometryCounts(geo: THREE.BufferGeometry): { verts: number; tris: number } {
  const pos = geo.getAttribute('position');
  const verts = pos ? pos.count : 0;
  const index = geo.getIndex();
  const tris = index ? Math.floor(index.count / 3) : Math.floor(verts / 3);
  return { verts, tris };
}

/** Dispose every registry entry not present in `keep`. */
export function sweep(keep: Set<string>): number {
  let disposed = 0;
  for (const [ref, geo] of [...geometries]) {
    if (!keep.has(ref)) {
      geo.dispose();
      geometries.delete(ref);
      disposed += 1;
    }
  }
  for (const [ref, tex] of [...textures]) {
    if (!keep.has(ref)) {
      tex.dispose();
      textures.delete(ref);
      disposed += 1;
    }
  }
  return disposed;
}

export function disposeAll(): void {
  sweep(new Set());
}

export function registrySize(): { geometries: number; textures: number } {
  return { geometries: geometries.size, textures: textures.size };
}
