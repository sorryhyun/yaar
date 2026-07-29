/**
 * obj.ts — Wavefront OBJ (+ basic MTL when a sibling .mtl can be resolved).
 * Hand-rolled: three/examples/jsm/OBJLoader is not available.
 *
 * Supports: v / vn / vt / f (v, v/vt, v//vn, v/vt/vn, negative indices),
 * o and g → separate meshes, usemtl → separate meshes, n-gon fan triangulation.
 */
import * as THREE from '@bundled/three';
import type { LoadOptions, LoadResult } from './types';

interface MtlDef {
  color: THREE.Color;
  specular: number;
  opacity: number;
}

function parseMTL(text: string): Map<string, MtlDef> {
  const out = new Map<string, MtlDef>();
  let cur: MtlDef | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    const key = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    const val = sp < 0 ? '' : line.slice(sp + 1).trim();
    if (key === 'newmtl') {
      cur = { color: new THREE.Color(0xcccccc), specular: 0.3, opacity: 1 };
      out.set(val, cur);
    } else if (!cur) {
      continue;
    } else if (key === 'kd') {
      const p = val.split(/\s+/).map(Number);
      if (p.length >= 3) cur.color.setRGB(p[0] || 0, p[1] || 0, p[2] || 0);
    } else if (key === 'ns') {
      const ns = Number(val);
      if (Number.isFinite(ns)) cur.specular = Math.min(1, Math.max(0, ns / 400));
    } else if (key === 'd') {
      const d = Number(val);
      if (Number.isFinite(d)) cur.opacity = Math.min(1, Math.max(0, d));
    } else if (key === 'tr') {
      const tr = Number(val);
      if (Number.isFinite(tr)) cur.opacity = 1 - Math.min(1, Math.max(0, tr));
    }
  }
  return out;
}

interface Chunk {
  name: string;
  material: string;
  position: number[];
  normal: number[];
  uv: number[];
}

function idx(raw: string, len: number): number {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n === 0) return -1;
  return n > 0 ? n - 1 : len + n;
}

export async function loadOBJ(
  buf: ArrayBuffer,
  opts: LoadOptions,
): Promise<LoadResult> {
  const warnings: string[] = [];
  const text = new TextDecoder().decode(new Uint8Array(buf));

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  const chunks: Chunk[] = [];
  let objectName = opts.name.replace(/\.[^.]+$/, '') || 'OBJ';
  let materialName = '';
  let cur: Chunk | null = null;
  let mtlLib = '';

  const startChunk = () => {
    cur = {
      name: objectName,
      material: materialName,
      position: [],
      normal: [],
      uv: [],
    };
    chunks.push(cur);
  };

  const emitVertex = (token: string) => {
    if (!cur) startChunk();
    const chunk = cur!;
    const parts = token.split('/');
    const vi = idx(parts[0], positions.length / 3);
    if (vi < 0 || vi * 3 + 2 >= positions.length) return;
    chunk.position.push(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]);
    if (parts.length > 1 && parts[1]) {
      const ti = idx(parts[1], uvs.length / 2);
      if (ti >= 0 && ti * 2 + 1 < uvs.length) chunk.uv.push(uvs[ti * 2], uvs[ti * 2 + 1]);
      else chunk.uv.push(0, 0);
    } else {
      chunk.uv.push(0, 0);
    }
    if (parts.length > 2 && parts[2]) {
      const ni = idx(parts[2], normals.length / 3);
      if (ni >= 0 && ni * 3 + 2 < normals.length) {
        chunk.normal.push(normals[ni * 3], normals[ni * 3 + 1], normals[ni * 3 + 2]);
      } else {
        chunk.normal.push(0, 0, 0);
      }
    } else {
      chunk.normal.push(0, 0, 0);
    }
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim();

    if (key === 'v') {
      const p = rest.split(/\s+/);
      positions.push(Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0);
    } else if (key === 'vn') {
      const p = rest.split(/\s+/);
      normals.push(Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0);
    } else if (key === 'vt') {
      const p = rest.split(/\s+/);
      uvs.push(Number(p[0]) || 0, Number(p[1]) || 0);
    } else if (key === 'f') {
      const tokens = rest.split(/\s+/).filter(Boolean);
      if (tokens.length < 3) continue;
      // fan triangulation of n-gons
      for (let i = 1; i < tokens.length - 1; i += 1) {
        emitVertex(tokens[0]);
        emitVertex(tokens[i]);
        emitVertex(tokens[i + 1]);
      }
    } else if (key === 'o' || key === 'g') {
      objectName = rest || objectName;
      cur = null;
    } else if (key === 'usemtl') {
      materialName = rest;
      cur = null;
    } else if (key === 'mtllib') {
      mtlLib = rest;
    }
  }

  let mtls = new Map<string, MtlDef>();
  if (mtlLib && opts.resolve) {
    try {
      const data = await opts.resolve(mtlLib);
      if (data) mtls = parseMTL(new TextDecoder().decode(new Uint8Array(data)));
      else warnings.push(`Material library "${mtlLib}" not found next to the model — using defaults.`);
    } catch {
      warnings.push(`Could not read material library "${mtlLib}" — using defaults.`);
    }
  } else if (mtlLib) {
    warnings.push(`Model references "${mtlLib}"; materials default to grey.`);
  }

  const usable = chunks.filter((c) => c.position.length >= 9);
  if (usable.length === 0) throw new Error('OBJ contained no triangles.');

  const group = new THREE.Group();
  group.name = opts.name.replace(/\.[^.]+$/, '') || 'OBJ';

  for (const chunk of usable) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(chunk.position, 3));
    const hasNormals = chunk.normal.some((n) => n !== 0);
    if (hasNormals) geo.setAttribute('normal', new THREE.Float32BufferAttribute(chunk.normal, 3));
    else geo.computeVertexNormals();
    if (chunk.uv.some((v) => v !== 0)) {
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(chunk.uv, 2));
    }
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    const def = mtls.get(chunk.material);
    const mat = new THREE.MeshStandardMaterial({
      color: def ? def.color.clone() : new THREE.Color(0xb9c4d0),
      roughness: def ? 1 - def.specular * 0.7 : 0.7,
      metalness: 0.05,
      opacity: def ? def.opacity : 1,
      transparent: def ? def.opacity < 1 : false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = chunk.material ? `${chunk.name}:${chunk.material}` : chunk.name;
    group.add(mesh);
  }

  if (group.children.length === 1) {
    const only = group.children[0];
    only.name = group.name;
    return { object: only, warnings };
  }
  return { object: group, warnings };
}
