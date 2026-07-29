/**
 * scene-doc.ts — THE SOURCE OF TRUTH.
 *
 * A plain, JSON-serializable node tree. three.js objects are a RENDER TARGET
 * reconciled from this document (see reconcile.ts); they are never authoritative.
 *
 * EVERY mutation goes through `applyOp(doc, op)`, which returns a new document
 * plus the inverse op. Phase 2 bolts an undo/redo command stack onto exactly
 * that pair — see store.ts, which already keeps the stacks.
 *
 * Conventions:
 *  - rotation is Euler XYZ in DEGREES (agent- and human-friendly). The
 *    reconciler converts to radians. Nothing else should touch radians.
 *  - large vertex buffers never live in the doc: a mesh geometry of type
 *    'buffer' carries a `bufferRef` into the registry (registry.ts).
 */

export type Vec3 = { x: number; y: number; z: number };

export interface Transform {
  /** position */
  p: Vec3;
  /** rotation, Euler XYZ, DEGREES */
  r: Vec3;
  /** scale */
  s: Vec3;
}

export type PrimitiveType =
  | 'box'
  | 'sphere'
  | 'cylinder'
  | 'cone'
  | 'plane'
  | 'torus'
  | 'torusKnot';

export type GeometryType = PrimitiveType | 'buffer';

export interface GeometryDef {
  type: GeometryType;
  /** Parameters for procedural primitives (width, radius, segments…). */
  params?: Record<string, number>;
  /** Registry key for an imported BufferGeometry. */
  bufferRef?: string;
  /** Import-time hints; live counts come from the reconciler. */
  vertexCount?: number;
  triangleCount?: number;
}

export interface MaterialDef {
  color: string;
  emissive: string;
  metalness: number;
  roughness: number;
  opacity: number;
  transparent: boolean;
  wireframe: boolean;
  flatShading: boolean;
  doubleSided: boolean;
  /** Registry key for an imported texture. */
  mapRef?: string;
}

export interface SceneNode {
  id: string;
  name: string;
  kind: 'mesh' | 'group';
  visible: boolean;
  transform: Transform;
  geometry?: GeometryDef;
  material?: MaterialDef;
  children: SceneNode[];
}

export interface SceneDoc {
  version: 1;
  name: string;
  root: SceneNode;
}

export const ROOT_ID = 'root';

/* ------------------------------------------------------------------ */
/* factories                                                           */
/* ------------------------------------------------------------------ */

let idCounter = 0;

export function newId(prefix = 'n'): string {
  idCounter += 1;
  return `${prefix}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export function identityTransform(): Transform {
  return { p: vec3(0, 0, 0), r: vec3(0, 0, 0), s: vec3(1, 1, 1) };
}

export function defaultMaterial(): MaterialDef {
  return {
    color: '#b9c4d0',
    emissive: '#000000',
    metalness: 0.1,
    roughness: 0.65,
    opacity: 1,
    transparent: false,
    wireframe: false,
    flatShading: false,
    doubleSided: false,
  };
}

export function createGroupNode(name: string, id = newId('g')): SceneNode {
  return { id, name, kind: 'group', visible: true, transform: identityTransform(), children: [] };
}

export function createMeshNode(
  name: string,
  geometry: GeometryDef,
  material: MaterialDef = defaultMaterial(),
  id = newId('m'),
): SceneNode {
  return {
    id,
    name,
    kind: 'mesh',
    visible: true,
    transform: identityTransform(),
    geometry,
    material,
    children: [],
  };
}

export function createEmptyDoc(name = 'Untitled'): SceneDoc {
  return { version: 1, name, root: createGroupNode('Scene', ROOT_ID) };
}

/* ------------------------------------------------------------------ */
/* queries                                                             */
/* ------------------------------------------------------------------ */

export function walk(node: SceneNode, fn: (n: SceneNode, parent: SceneNode | null) => void): void {
  const rec = (n: SceneNode, parent: SceneNode | null) => {
    fn(n, parent);
    for (const c of n.children) rec(c, n);
  };
  rec(node, null);
}

export function findNode(doc: SceneDoc, id: string): SceneNode | null {
  let hit: SceneNode | null = null;
  walk(doc.root, (n) => {
    if (!hit && n.id === id) hit = n;
  });
  return hit;
}

export function findParent(doc: SceneDoc, id: string): SceneNode | null {
  let hit: SceneNode | null = null;
  walk(doc.root, (n, parent) => {
    if (!hit && n.id === id) hit = parent;
  });
  return hit;
}

export function collectBufferRefs(doc: SceneDoc): Set<string> {
  const refs = new Set<string>();
  walk(doc.root, (n) => {
    if (n.geometry?.bufferRef) refs.add(n.geometry.bufferRef);
    if (n.material?.mapRef) refs.add(n.material.mapRef);
  });
  return refs;
}

export function countNodes(doc: SceneDoc): { nodes: number; meshes: number } {
  let nodes = 0;
  let meshes = 0;
  walk(doc.root, (n) => {
    if (n.id !== ROOT_ID) nodes += 1;
    if (n.kind === 'mesh') meshes += 1;
  });
  return { nodes, meshes };
}

export function cloneDoc(doc: SceneDoc): SceneDoc {
  return JSON.parse(JSON.stringify(doc)) as SceneDoc;
}

/* ------------------------------------------------------------------ */
/* ops                                                                 */
/* ------------------------------------------------------------------ */

export type SceneOp =
  | { type: 'addNode'; parentId: string; node: SceneNode; index?: number }
  | { type: 'removeNode'; id: string }
  | { type: 'renameNode'; id: string; name: string }
  | { type: 'setVisible'; id: string; visible: boolean }
  | {
      type: 'setTransform';
      id: string;
      position?: Partial<Vec3>;
      rotation?: Partial<Vec3>;
      scale?: Partial<Vec3>;
    }
  | { type: 'setMaterial'; id: string; patch: Partial<MaterialDef> }
  | { type: 'setGeometry'; id: string; patch: Partial<GeometryDef> }
  | { type: 'reparent'; id: string; parentId: string; index?: number }
  | { type: 'setDocName'; name: string }
  | { type: 'replaceRoot'; root: SceneNode; name?: string }
  | { type: 'clear' };

export interface OpResult {
  doc: SceneDoc;
  /** The op that undoes this one, or null when the op was a no-op. */
  inverse: SceneOp | null;
  changed: boolean;
}

function noop(doc: SceneDoc): OpResult {
  return { doc, inverse: null, changed: false };
}

function mergeVec(target: Vec3, patch: Partial<Vec3> | undefined): void {
  if (!patch) return;
  if (typeof patch.x === 'number') target.x = patch.x;
  if (typeof patch.y === 'number') target.y = patch.y;
  if (typeof patch.z === 'number') target.z = patch.z;
}

/**
 * The single mutation funnel. Pure: `doc` is never modified in place.
 */
export function applyOp(doc: SceneDoc, op: SceneOp): OpResult {
  const next = cloneDoc(doc);

  switch (op.type) {
    case 'addNode': {
      const parent = findNode(next, op.parentId);
      if (!parent) return noop(doc);
      const node = JSON.parse(JSON.stringify(op.node)) as SceneNode;
      const idx = op.index ?? parent.children.length;
      parent.children.splice(Math.max(0, Math.min(idx, parent.children.length)), 0, node);
      return { doc: next, inverse: { type: 'removeNode', id: node.id }, changed: true };
    }

    case 'removeNode': {
      if (op.id === ROOT_ID) return noop(doc);
      const parent = findParent(next, op.id);
      if (!parent) return noop(doc);
      const idx = parent.children.findIndex((c) => c.id === op.id);
      if (idx < 0) return noop(doc);
      const [removed] = parent.children.splice(idx, 1);
      return {
        doc: next,
        inverse: { type: 'addNode', parentId: parent.id, node: removed, index: idx },
        changed: true,
      };
    }

    case 'renameNode': {
      const node = findNode(next, op.id);
      if (!node || node.name === op.name) return noop(doc);
      const prev = node.name;
      node.name = op.name;
      return { doc: next, inverse: { type: 'renameNode', id: op.id, name: prev }, changed: true };
    }

    case 'setVisible': {
      const node = findNode(next, op.id);
      if (!node || node.visible === op.visible) return noop(doc);
      const prev = node.visible;
      node.visible = op.visible;
      return { doc: next, inverse: { type: 'setVisible', id: op.id, visible: prev }, changed: true };
    }

    case 'setTransform': {
      const node = findNode(next, op.id);
      if (!node) return noop(doc);
      const before: Transform = JSON.parse(JSON.stringify(node.transform));
      mergeVec(node.transform.p, op.position);
      mergeVec(node.transform.r, op.rotation);
      mergeVec(node.transform.s, op.scale);
      return {
        doc: next,
        inverse: {
          type: 'setTransform',
          id: op.id,
          position: before.p,
          rotation: before.r,
          scale: before.s,
        },
        changed: true,
      };
    }

    case 'setMaterial': {
      const node = findNode(next, op.id);
      if (!node) return noop(doc);
      const mat = node.material ?? defaultMaterial();
      const before: Partial<MaterialDef> = {};
      for (const key of Object.keys(op.patch) as (keyof MaterialDef)[]) {
        (before as Record<string, unknown>)[key] = mat[key];
      }
      node.material = { ...mat, ...op.patch };
      return {
        doc: next,
        inverse: { type: 'setMaterial', id: op.id, patch: before },
        changed: true,
      };
    }

    case 'setGeometry': {
      const node = findNode(next, op.id);
      if (!node || !node.geometry) return noop(doc);
      const before: Partial<GeometryDef> = {};
      for (const key of Object.keys(op.patch) as (keyof GeometryDef)[]) {
        (before as Record<string, unknown>)[key] = node.geometry[key];
      }
      node.geometry = { ...node.geometry, ...op.patch } as GeometryDef;
      return { doc: next, inverse: { type: 'setGeometry', id: op.id, patch: before }, changed: true };
    }

    case 'reparent': {
      if (op.id === ROOT_ID) return noop(doc);
      const oldParent = findParent(next, op.id);
      const newParent = findNode(next, op.parentId);
      if (!oldParent || !newParent) return noop(doc);
      // refuse to move a node into its own subtree
      let cycle = false;
      const moving = findNode(next, op.id);
      if (!moving) return noop(doc);
      walk(moving, (n) => {
        if (n.id === op.parentId) cycle = true;
      });
      if (cycle) return noop(doc);
      const oldIdx = oldParent.children.findIndex((c) => c.id === op.id);
      oldParent.children.splice(oldIdx, 1);
      const idx = op.index ?? newParent.children.length;
      newParent.children.splice(Math.max(0, Math.min(idx, newParent.children.length)), 0, moving);
      return {
        doc: next,
        inverse: { type: 'reparent', id: op.id, parentId: oldParent.id, index: oldIdx },
        changed: true,
      };
    }

    case 'setDocName': {
      if (next.name === op.name) return noop(doc);
      const prev = next.name;
      next.name = op.name;
      return { doc: next, inverse: { type: 'setDocName', name: prev }, changed: true };
    }

    case 'replaceRoot': {
      const prevRoot = next.root;
      const prevName = next.name;
      next.root = JSON.parse(JSON.stringify(op.root)) as SceneNode;
      next.root.id = ROOT_ID;
      if (op.name) next.name = op.name;
      return {
        doc: next,
        inverse: { type: 'replaceRoot', root: prevRoot, name: prevName },
        changed: true,
      };
    }

    case 'clear': {
      if (next.root.children.length === 0) return noop(doc);
      const prevRoot = next.root;
      next.root = createGroupNode('Scene', ROOT_ID);
      next.name = 'Untitled';
      return {
        doc: next,
        inverse: { type: 'replaceRoot', root: prevRoot, name: doc.name },
        changed: true,
      };
    }

    default:
      return noop(doc);
  }
}

/** Convenience: run a batch of ops, returning the final doc and reversed inverses. */
export function applyOps(doc: SceneDoc, ops: SceneOp[]): { doc: SceneDoc; inverses: SceneOp[] } {
  let cur = doc;
  const inverses: SceneOp[] = [];
  for (const op of ops) {
    const res = applyOp(cur, op);
    cur = res.doc;
    if (res.inverse) inverses.unshift(res.inverse);
  }
  return { doc: cur, inverses };
}
