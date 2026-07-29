/**
 * import-object.ts — three.js graph  →  SceneDoc nodes.
 *
 * Loaders produce three objects (that is the natural output of a parser); this
 * converts them once, at import time, into doc nodes, parking the heavy
 * BufferGeometry / Texture in the registry behind a ref. After this runs the
 * doc is again the only source of truth.
 */
import * as THREE from '@bundled/three';
import {
  createGroupNode,
  createMeshNode,
  defaultMaterial,
  newId,
  type MaterialDef,
  type SceneNode,
} from './scene-doc';
import { geometryCounts, putGeometry, putTexture } from './registry';

const RAD2DEG = 180 / Math.PI;

function materialFrom(src: THREE.Material | THREE.Material[] | undefined): MaterialDef {
  const def = defaultMaterial();
  const mat = Array.isArray(src) ? src[0] : src;
  if (!mat) return def;
  const std = mat as THREE.MeshStandardMaterial;
  if (std.color) def.color = `#${std.color.getHexString()}`;
  if (std.emissive) def.emissive = `#${std.emissive.getHexString()}`;
  if (typeof std.metalness === 'number') def.metalness = std.metalness;
  if (typeof std.roughness === 'number') def.roughness = std.roughness;
  if (typeof std.opacity === 'number') def.opacity = std.opacity;
  def.transparent = !!std.transparent;
  def.wireframe = !!std.wireframe;
  def.flatShading = !!std.flatShading;
  def.doubleSided = std.side === THREE.DoubleSide;
  if (std.map) def.mapRef = putTexture(std.map);
  return def;
}

export interface ImportSummary {
  node: SceneNode;
  meshes: number;
  verts: number;
  tris: number;
}

export function importObject3D(obj: THREE.Object3D, fallbackName: string): ImportSummary {
  let meshes = 0;
  let verts = 0;
  let tris = 0;

  const convert = (o: THREE.Object3D, depth: number): SceneNode | null => {
    const name = o.name || (depth === 0 ? fallbackName : o.type);
    const isMesh = (o as unknown as { isMesh?: boolean }).isMesh === true;

    let node: SceneNode;
    if (isMesh) {
      const mesh = o as THREE.Mesh;
      const geo = mesh.geometry as THREE.BufferGeometry;
      const counts = geometryCounts(geo);
      meshes += 1;
      verts += counts.verts;
      tris += counts.tris;
      node = createMeshNode(
        name,
        {
          type: 'buffer',
          bufferRef: putGeometry(geo),
          vertexCount: counts.verts,
          triangleCount: counts.tris,
        },
        materialFrom(mesh.material),
        newId('m'),
      );
      // the loader's material was never rendered; the reconciler owns materials
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) (mat as THREE.Material).dispose();
    } else {
      node = createGroupNode(name, newId('g'));
    }

    node.visible = o.visible;
    node.transform = {
      p: { x: o.position.x, y: o.position.y, z: o.position.z },
      r: {
        x: o.rotation.x * RAD2DEG,
        y: o.rotation.y * RAD2DEG,
        z: o.rotation.z * RAD2DEG,
      },
      s: { x: o.scale.x, y: o.scale.y, z: o.scale.z },
    };

    for (const child of o.children) {
      const converted = convert(child, depth + 1);
      if (converted) node.children.push(converted);
    }

    // drop empty leaf groups that carry no transform information
    if (!isMesh && node.children.length === 0) return null;
    return node;
  };

  const node = convert(obj, 0) ?? createGroupNode(fallbackName, newId('g'));
  return { node, meshes, verts, tris };
}
