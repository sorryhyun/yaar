/**
 * stl.ts — binary + ASCII STL. Hand-rolled: three/examples/jsm/STLLoader is
 * not available in @bundled/three.
 */
import * as THREE from '@bundled/three';
import type { LoadResult } from './types';

function looksBinary(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 84) return false;
  const view = new DataView(buf);
  const tris = view.getUint32(80, true);
  if (84 + tris * 50 === buf.byteLength) return true;
  // Some writers pad. Fall back to a control-character sniff of the header.
  const head = new Uint8Array(buf, 0, Math.min(buf.byteLength, 512));
  let solid = true;
  const magic = 'solid';
  for (let i = 0; i < magic.length; i += 1) {
    if (head[i] !== magic.charCodeAt(i)) solid = false;
  }
  if (solid) return false;
  for (let i = 0; i < head.length; i += 1) {
    const c = head[i];
    if (c > 127) return true;
  }
  return false;
}

function parseBinary(buf: ArrayBuffer): THREE.BufferGeometry {
  const view = new DataView(buf);
  const tris = view.getUint32(80, true);
  const maxTris = Math.floor((buf.byteLength - 84) / 50);
  const count = Math.min(tris, Math.max(maxTris, 0));

  const positions = new Float32Array(count * 9);
  const normals = new Float32Array(count * 9);
  const colors: number[] = [];
  let hasColor = false;

  for (let i = 0; i < count; i += 1) {
    const o = 84 + i * 50;
    const nx = view.getFloat32(o, true);
    const ny = view.getFloat32(o + 4, true);
    const nz = view.getFloat32(o + 8, true);
    for (let v = 0; v < 3; v += 1) {
      const p = o + 12 + v * 12;
      const idx = i * 9 + v * 3;
      positions[idx] = view.getFloat32(p, true);
      positions[idx + 1] = view.getFloat32(p + 4, true);
      positions[idx + 2] = view.getFloat32(p + 8, true);
      normals[idx] = nx;
      normals[idx + 1] = ny;
      normals[idx + 2] = nz;
    }
    const attr = view.getUint16(o + 48, true);
    if (attr & 0x8000) {
      hasColor = true;
      const r = (attr & 0x1f) / 31;
      const g = ((attr >> 5) & 0x1f) / 31;
      const b = ((attr >> 10) & 0x1f) / 31;
      for (let v = 0; v < 3; v += 1) colors.push(r, g, b);
    } else if (hasColor) {
      for (let v = 0; v < 3; v += 1) colors.push(1, 1, 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (hasColor && colors.length === count * 9) {
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  }
  return geo;
}

function parseAscii(text: string): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  let nx = 0;
  let ny = 0;
  let nz = 1;

  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('facet normal')) {
      const p = line.split(/\s+/);
      nx = parseFloat(p[2]) || 0;
      ny = parseFloat(p[3]) || 0;
      nz = parseFloat(p[4]) || 0;
    } else if (line.startsWith('vertex')) {
      const p = line.split(/\s+/);
      positions.push(parseFloat(p[1]) || 0, parseFloat(p[2]) || 0, parseFloat(p[3]) || 0);
      normals.push(nx, ny, nz);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return geo;
}

export function loadSTL(buf: ArrayBuffer, name: string): LoadResult {
  const warnings: string[] = [];
  let geo: THREE.BufferGeometry;
  if (looksBinary(buf)) {
    geo = parseBinary(buf);
  } else {
    const text = new TextDecoder().decode(new Uint8Array(buf));
    geo = parseAscii(text);
  }

  const pos = geo.getAttribute('position');
  if (!pos || pos.count === 0) throw new Error('STL contained no triangles.');

  // STL normals are per-facet and often garbage; recompute if degenerate.
  const nrm = geo.getAttribute('normal');
  let bad = 0;
  if (nrm) {
    for (let i = 0; i < nrm.count; i += 1) {
      const x = nrm.getX(i);
      const y = nrm.getY(i);
      const z = nrm.getZ(i);
      if (x * x + y * y + z * z < 1e-8) bad += 1;
    }
  }
  if (!nrm || bad > nrm.count * 0.25) {
    geo.computeVertexNormals();
    warnings.push('STL facet normals were missing or degenerate — recomputed.');
  }
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xb9c4d0 }));
  mesh.name = name.replace(/\.[^.]+$/, '') || 'STL';
  return { object: mesh, warnings };
}
