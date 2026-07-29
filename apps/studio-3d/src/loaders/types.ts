import type * as THREE from '@bundled/three';

export type ModelFormat = 'stl' | 'obj' | 'glb' | 'gltf' | 'scene';

export interface LoadResult {
  /** A three graph; converted to scene-doc nodes by import-object.ts. */
  object: THREE.Object3D;
  warnings: string[];
}

/**
 * Resolves a relative resource referenced by the asset (an .mtl sibling, a
 * .gltf's external .bin or image). Returns null when it cannot be fetched.
 */
export type ResourceResolver = (relativeUri: string) => Promise<ArrayBuffer | null>;

export interface LoadOptions {
  name: string;
  resolve?: ResourceResolver;
}
