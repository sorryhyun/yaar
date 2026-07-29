/**
 * reconcile.ts — SceneDoc  →  three.js Object3D graph.
 *
 * One-way. The doc is authoritative; this module makes the render target look
 * like it, creating / updating / destroying three objects as needed and
 * disposing anything it owns on the way out.
 *
 * Phase 2/3 (primitives, gizmo, CSG) only ever mutate the doc; this file needs
 * no changes for them beyond new entries in PRIMITIVE_DEFAULTS.
 */
import * as THREE from '@bundled/three';
import {
  type GeometryDef,
  type MaterialDef,
  type PrimitiveType,
  type SceneDoc,
  type SceneNode,
} from './scene-doc';
import { getGeometry, getTexture, geometryCounts } from './registry';

const DEG = Math.PI / 180;

export const PRIMITIVE_DEFAULTS: Record<PrimitiveType, Record<string, number>> = {
  box: { width: 1, height: 1, depth: 1, widthSegments: 1, heightSegments: 1, depthSegments: 1 },
  sphere: { radius: 0.6, widthSegments: 32, heightSegments: 20 },
  cylinder: { radiusTop: 0.5, radiusBottom: 0.5, height: 1, radialSegments: 32 },
  cone: { radius: 0.5, height: 1, radialSegments: 32 },
  plane: { width: 1, height: 1, widthSegments: 1, heightSegments: 1 },
  torus: { radius: 0.5, tube: 0.18, radialSegments: 16, tubularSegments: 48 },
  torusKnot: { radius: 0.5, tube: 0.16, tubularSegments: 96, radialSegments: 16, p: 2, q: 3 },
};

function num(params: Record<string, number> | undefined, key: string, fallback: number): number {
  const v = params?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function buildPrimitive(def: GeometryDef): THREE.BufferGeometry {
  const p = def.params;
  const d = PRIMITIVE_DEFAULTS[def.type as PrimitiveType] ?? {};
  switch (def.type) {
    case 'sphere':
      return new THREE.SphereGeometry(
        num(p, 'radius', d.radius),
        num(p, 'widthSegments', d.widthSegments),
        num(p, 'heightSegments', d.heightSegments),
      );
    case 'cylinder':
      return new THREE.CylinderGeometry(
        num(p, 'radiusTop', d.radiusTop),
        num(p, 'radiusBottom', d.radiusBottom),
        num(p, 'height', d.height),
        num(p, 'radialSegments', d.radialSegments),
      );
    case 'cone':
      return new THREE.ConeGeometry(
        num(p, 'radius', d.radius),
        num(p, 'height', d.height),
        num(p, 'radialSegments', d.radialSegments),
      );
    case 'plane':
      return new THREE.PlaneGeometry(
        num(p, 'width', d.width),
        num(p, 'height', d.height),
        num(p, 'widthSegments', d.widthSegments),
        num(p, 'heightSegments', d.heightSegments),
      );
    case 'torus':
      return new THREE.TorusGeometry(
        num(p, 'radius', d.radius),
        num(p, 'tube', d.tube),
        num(p, 'radialSegments', d.radialSegments),
        num(p, 'tubularSegments', d.tubularSegments),
      );
    case 'torusKnot':
      return new THREE.TorusKnotGeometry(
        num(p, 'radius', d.radius),
        num(p, 'tube', d.tube),
        num(p, 'tubularSegments', d.tubularSegments),
        num(p, 'radialSegments', d.radialSegments),
        num(p, 'p', d.p),
        num(p, 'q', d.q),
      );
    case 'box':
    default:
      return new THREE.BoxGeometry(
        num(p, 'width', 1),
        num(p, 'height', 1),
        num(p, 'depth', 1),
        num(p, 'widthSegments', 1),
        num(p, 'heightSegments', 1),
        num(p, 'depthSegments', 1),
      );
  }
}

export interface SceneStats {
  meshes: number;
  verts: number;
  tris: number;
}

interface Entry {
  obj: THREE.Object3D;
  kind: 'mesh' | 'group';
  /** geometry we created ourselves (primitives) and must dispose */
  ownedGeo?: THREE.BufferGeometry;
  geoKey?: string;
  material?: THREE.MeshStandardMaterial;
}

function geoKeyOf(def: GeometryDef | undefined): string {
  if (!def) return 'none';
  if (def.type === 'buffer') return `buffer:${def.bufferRef ?? '?'}`;
  return `${def.type}:${JSON.stringify(def.params ?? {})}`;
}

export class SceneReconciler {
  readonly root = new THREE.Group();
  private entries = new Map<string, Entry>();
  private lastStats: SceneStats = { meshes: 0, verts: 0, tris: 0 };
  /** Set true when a mesh could not be built (missing buffer ref). */
  missingBuffers = 0;

  constructor() {
    this.root.name = 'SceneRoot';
  }

  sync(doc: SceneDoc): SceneStats {
    const seen = new Set<string>();
    this.missingBuffers = 0;
    this.syncChildren(this.root, doc.root.children, seen);

    // apply the root node's own transform/visibility
    this.applyTransform(this.root, doc.root);

    for (const [id, entry] of [...this.entries]) {
      if (!seen.has(id)) {
        entry.obj.removeFromParent();
        this.destroy(entry);
        this.entries.delete(id);
      }
    }

    this.lastStats = this.computeStats();
    return this.lastStats;
  }

  private syncChildren(parent: THREE.Object3D, nodes: SceneNode[], seen: Set<string>): void {
    const desired: THREE.Object3D[] = [];
    for (const node of nodes) {
      seen.add(node.id);
      let entry = this.entries.get(node.id);
      if (entry && entry.kind !== node.kind) {
        entry.obj.removeFromParent();
        this.destroy(entry);
        this.entries.delete(node.id);
        entry = undefined;
      }
      if (!entry) {
        entry = this.create(node);
        this.entries.set(node.id, entry);
      } else {
        this.update(entry, node);
      }
      entry.obj.name = node.name;
      entry.obj.userData.nodeId = node.id;
      this.applyTransform(entry.obj, node);
      desired.push(entry.obj);
      this.syncChildren(entry.obj, node.children, seen);
    }

    // reorder / attach without churning GPU resources
    const current = parent.children;
    let same = current.length === desired.length;
    if (same) {
      for (let i = 0; i < desired.length; i += 1) {
        if (current[i] !== desired[i]) {
          same = false;
          break;
        }
      }
    }
    if (!same) {
      for (const child of [...current]) parent.remove(child);
      for (const child of desired) parent.add(child);
    }
  }

  private applyTransform(obj: THREE.Object3D, node: SceneNode): void {
    const t = node.transform;
    obj.position.set(t.p.x, t.p.y, t.p.z);
    obj.rotation.set(t.r.x * DEG, t.r.y * DEG, t.r.z * DEG);
    obj.scale.set(t.s.x || 1e-6, t.s.y || 1e-6, t.s.z || 1e-6);
    obj.visible = node.visible;
  }

  private create(node: SceneNode): Entry {
    if (node.kind === 'group') {
      const obj = new THREE.Group();
      return { obj, kind: 'group' };
    }
    const entry: Entry = { obj: new THREE.Object3D(), kind: 'mesh' };
    const { geometry, owned } = this.resolveGeometry(node.geometry);
    const material = new THREE.MeshStandardMaterial();
    applyMaterial(material, node.material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    entry.obj = mesh;
    entry.material = material;
    entry.ownedGeo = owned;
    entry.geoKey = geoKeyOf(node.geometry);
    return entry;
  }

  private update(entry: Entry, node: SceneNode): void {
    if (entry.kind !== 'mesh') return;
    const mesh = entry.obj as THREE.Mesh;
    const key = geoKeyOf(node.geometry);
    if (key !== entry.geoKey) {
      const { geometry, owned } = this.resolveGeometry(node.geometry);
      if (entry.ownedGeo) entry.ownedGeo.dispose();
      entry.ownedGeo = owned;
      entry.geoKey = key;
      mesh.geometry = geometry;
    }
    if (entry.material) applyMaterial(entry.material, node.material);
  }

  private resolveGeometry(def: GeometryDef | undefined): {
    geometry: THREE.BufferGeometry;
    owned?: THREE.BufferGeometry;
  } {
    if (def && def.type === 'buffer') {
      const geo = getGeometry(def.bufferRef);
      if (geo) return { geometry: geo };
      this.missingBuffers += 1;
      const fallback = new THREE.BoxGeometry(0.2, 0.2, 0.2);
      return { geometry: fallback, owned: fallback };
    }
    const geo = buildPrimitive(def ?? { type: 'box' });
    return { geometry: geo, owned: geo };
  }

  private destroy(entry: Entry): void {
    entry.ownedGeo?.dispose();
    if (entry.material) {
      // textures are registry-owned; never dispose them here
      entry.material.dispose();
    }
  }

  private computeStats(): SceneStats {
    let meshes = 0;
    let verts = 0;
    let tris = 0;
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if ((mesh as unknown as { isMesh?: boolean }).isMesh && mesh.geometry) {
        meshes += 1;
        const c = geometryCounts(mesh.geometry);
        verts += c.verts;
        tris += c.tris;
      }
    });
    return { meshes, verts, tris };
  }

  stats(): SceneStats {
    return this.lastStats;
  }

  object(id: string): THREE.Object3D | undefined {
    return this.entries.get(id)?.obj;
  }

  meshCounts(id: string): { verts: number; tris: number } | null {
    const entry = this.entries.get(id);
    if (!entry || entry.kind !== 'mesh') return null;
    const mesh = entry.obj as THREE.Mesh;
    if (!mesh.geometry) return null;
    return geometryCounts(mesh.geometry);
  }

  /** Global wireframe override; `null` restores each material's own flag. */
  applyWireframeOverride(force: boolean | null, doc: SceneDoc): void {
    const byId = new Map<string, SceneNode>();
    const rec = (n: SceneNode) => {
      byId.set(n.id, n);
      n.children.forEach(rec);
    };
    rec(doc.root);
    for (const [id, entry] of this.entries) {
      if (!entry.material) continue;
      entry.material.wireframe = force ?? byId.get(id)?.material?.wireframe ?? false;
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.obj.removeFromParent();
      this.destroy(entry);
    }
    this.entries.clear();
  }
}

function applyMaterial(mat: THREE.MeshStandardMaterial, def: MaterialDef | undefined): void {
  if (!def) return;
  mat.color.set(def.color || '#ffffff');
  mat.emissive.set(def.emissive || '#000000');
  mat.metalness = clamp01(def.metalness);
  mat.roughness = clamp01(def.roughness);
  mat.opacity = clamp01(def.opacity);
  mat.transparent = !!def.transparent || def.opacity < 1;
  mat.wireframe = !!def.wireframe;
  mat.side = def.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
  if (mat.flatShading !== !!def.flatShading) {
    mat.flatShading = !!def.flatShading;
    mat.needsUpdate = true;
  }
  const tex = getTexture(def.mapRef) ?? null;
  if (mat.map !== tex) {
    mat.map = tex;
    mat.needsUpdate = true;
  }
}

function clamp01(v: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}
