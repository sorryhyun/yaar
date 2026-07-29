/**
 * protocol.ts — the agent-facing surface.
 *
 * Every command routes through store.mutate() → applyOp, the same funnel the UI
 * uses, so a Phase 3 agent can build geometry purely through commands and get
 * identical results (and identical undo behaviour) to a human clicking.
 */
import * as z from '@bundled/zod';
import { AppCommandError, defineAppCommand } from '@bundled/yaar';
import {
  clearScene,
  doc,
  frameAll,
  frameSelection,
  gridOn,
  listSavedScenes,
  loadFromStorage,
  loadFromUrl,
  loadSample,
  mutate,
  openSavedScene,
  redo,
  renderPNG,
  saveScene,
  select,
  selectedNode,
  selection,
  setGrid,
  setWireframe,
  stats,
  undo,
  wireframeOn,
  reconciler,
} from './store';
import {
  createGroupNode,
  createMeshNode,
  defaultMaterial,
  findNode,
  newId,
  ROOT_ID,
  type MaterialDef,
  type PrimitiveType,
} from './scene-doc';
import { PRIMITIVE_DEFAULTS } from './reconcile';

const PARTIAL_VEC = z.object({
  x: z.optional(z.number()),
  y: z.optional(z.number()),
  z: z.optional(z.number()),
});

const PRIMITIVE_NAMES = [
  'box',
  'sphere',
  'cylinder',
  'cone',
  'plane',
  'torus',
  'torusKnot',
] as const;

function requireNode(id: string) {
  const node = findNode(doc(), id);
  if (!node) throw new AppCommandError(`No node with id "${id}" in the scene.`);
  return node;
}

/* ---------------------------------------------------------------- state -- */

export const appState = {
  scene: {
    description:
      'The full scene document: a serializable node tree { id, name, kind, transform{p,r,s}, ' +
      'geometry, material, children }. Rotations are Euler XYZ in DEGREES. This is the source ' +
      'of truth; the three.js graph is reconciled from it.',
    get: () => doc(),
  },
  selection: {
    description: 'The currently selected node id and its full node object (null when nothing is selected).',
    get: () => ({ id: selection(), node: selectedNode() }),
  },
  stats: {
    description:
      'Scene counters: nodes, meshes, verts, tris, fps, plus the grid/wireframe view toggles.',
    get: () => ({ ...stats(), grid: gridOn(), wireframe: wireframeOn() }),
  },
};

/* ------------------------------------------------------------- commands -- */

export const loadCommands = {
  loadModel: defineAppCommand({
    description:
      'Load a 3D model, replacing the current scene. Give either uri (a yaar://storage/ path) ' +
      'or url (fetched through the HTTP proxy). Formats: .glb, .gltf, .obj, .stl, .scene.json. ' +
      'Draco/meshopt-compressed and sparse-accessor glTF are refused with an explanation.',
    params: z.object({
      uri: z.optional(z.string()),
      url: z.optional(z.string()),
    }),
    replay: 'always',
    run: async (p) => {
      if (p.uri) return await loadFromStorage(p.uri);
      if (p.url) return await loadFromUrl(p.url);
      throw new AppCommandError('Pass either "uri" (storage path) or "url" (http).');
    },
  }),

  loadSample: defineAppCommand({
    description: 'Build the procedural demo scene (torus knot, primitives, pedestal, ground plane).',
    run: () => {
      loadSample();
      return { ok: true, nodes: stats().nodes, tris: stats().tris };
    },
  }),

  clearScene: defineAppCommand({
    description: 'Remove every node and dispose all GPU resources. Resets undo history.',
    run: () => {
      clearScene();
      return { ok: true };
    },
  }),

  saveScene: defineAppCommand({
    description: "Save the scene document as a .scene.json file in the app's own storage.",
    params: z.object({ name: z.optional(z.string()) }),
    replay: 'never',
    run: async (p) => ({ path: await saveScene(p.name) }),
  }),

  listScenes: defineAppCommand({
    description: 'List saved .scene.json files in app storage.',
    run: async () => ({ scenes: await listSavedScenes() }),
  }),

  openScene: defineAppCommand({
    description: 'Open a saved .scene.json file from app storage (path as returned by listScenes).',
    params: z.object({ path: z.string() }),
    run: async (p) => {
      await openSavedScene(p.path);
      return { ok: true, name: doc().name, nodes: stats().nodes };
    },
  }),

  renderPNG: defineAppCommand({
    description:
      'Render the current viewport to a PNG. Defaults to media/studio-3d/<name>-<timestamp>.png ' +
      'in the shared media tree, where other apps can pick it up.',
    params: z.object({ path: z.optional(z.string()) }),
    replay: 'never',
    run: async (p) => ({ uri: await renderPNG(p.path) }),
  }),
};

export const editCommands = {
  select: defineAppCommand({
    description: 'Select a node by id (pass null to clear). Highlights it and fills the inspector.',
    params: z.object({ id: z.nullable(z.string()) }),
    run: (p) => {
      if (p.id === null) {
        select(null);
        return { id: null };
      }
      requireNode(p.id);
      select(p.id);
      return { id: p.id, node: selectedNode() };
    },
  }),

  setTransform: defineAppCommand({
    description:
      'Set position / rotation / scale on a node. Each is a partial {x,y,z} — omitted axes keep ' +
      'their value. Rotation is in DEGREES.',
    params: z.object({
      id: z.string(),
      position: z.optional(PARTIAL_VEC),
      rotation: z.optional(PARTIAL_VEC),
      scale: z.optional(PARTIAL_VEC),
    }),
    run: (p) => {
      requireNode(p.id);
      mutate({
        type: 'setTransform',
        id: p.id,
        position: p.position,
        rotation: p.rotation,
        scale: p.scale,
      });
      return { transform: requireNode(p.id).transform };
    },
  }),

  setMaterial: defineAppCommand({
    description: 'Patch material properties on a mesh node. Omitted fields are left alone.',
    params: z.object({
      id: z.string(),
      color: z.optional(z.string()),
      emissive: z.optional(z.string()),
      metalness: z.optional(z.number()),
      roughness: z.optional(z.number()),
      opacity: z.optional(z.number()),
      transparent: z.optional(z.boolean()),
      wireframe: z.optional(z.boolean()),
      flatShading: z.optional(z.boolean()),
      doubleSided: z.optional(z.boolean()),
    }),
    run: (p) => {
      const node = requireNode(p.id);
      if (node.kind !== 'mesh') throw new AppCommandError(`"${node.name}" is a group, not a mesh.`);
      const patch: Partial<MaterialDef> = {};
      for (const key of [
        'color',
        'emissive',
        'metalness',
        'roughness',
        'opacity',
        'transparent',
        'wireframe',
        'flatShading',
        'doubleSided',
      ] as const) {
        const value = (p as Record<string, unknown>)[key];
        if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
      }
      if (Object.keys(patch).length === 0) throw new AppCommandError('No material fields given.');
      mutate({ type: 'setMaterial', id: p.id, patch });
      return { material: requireNode(p.id).material };
    },
  }),

  setVisible: defineAppCommand({
    description: 'Show or hide a node (and its subtree).',
    params: z.object({ id: z.string(), visible: z.boolean() }),
    run: (p) => {
      requireNode(p.id);
      mutate({ type: 'setVisible', id: p.id, visible: p.visible });
      return { id: p.id, visible: p.visible };
    },
  }),

  renameNode: defineAppCommand({
    description: 'Rename a node.',
    params: z.object({ id: z.string(), name: z.string() }),
    run: (p) => {
      requireNode(p.id);
      mutate({ type: 'renameNode', id: p.id, name: p.name });
      return { id: p.id, name: p.name };
    },
  }),

  deleteNode: defineAppCommand({
    description: 'Delete a node and its subtree.',
    params: z.object({ id: z.string() }),
    run: (p) => {
      const node = requireNode(p.id);
      mutate({ type: 'removeNode', id: p.id });
      if (selection() === p.id) select(null);
      return { deleted: node.name };
    },
  }),

  deleteSelected: defineAppCommand({
    description: 'Delete the currently selected node.',
    run: () => {
      const id = selection();
      if (!id) throw new AppCommandError('Nothing is selected.');
      mutate({ type: 'removeNode', id });
      select(null);
      return { ok: true };
    },
  }),

  addPrimitive: defineAppCommand({
    description:
      'Add a procedural primitive mesh. Phase 3 geometry building goes through here: the node ' +
      'is created in the scene doc and reconciled into three.js automatically. Returns the new id.',
    params: z.object({
      type: z.enum(PRIMITIVE_NAMES),
      name: z.optional(z.string()),
      parentId: z.optional(z.string()),
      position: z.optional(PARTIAL_VEC),
      params: z.optional(z.record(z.string(), z.number())),
      color: z.optional(z.string()),
    }),
    run: (p) => {
      const parentId = p.parentId ?? ROOT_ID;
      if (parentId !== ROOT_ID) requireNode(parentId);
      const material = defaultMaterial();
      if (p.color) material.color = p.color;
      const node = createMeshNode(
        p.name ?? p.type,
        {
          type: p.type as PrimitiveType,
          params: { ...PRIMITIVE_DEFAULTS[p.type as PrimitiveType], ...(p.params ?? {}) },
        },
        material,
        newId('m'),
      );
      if (p.position) {
        node.transform.p = {
          x: p.position.x ?? 0,
          y: p.position.y ?? 0,
          z: p.position.z ?? 0,
        };
      }
      mutate({ type: 'addNode', parentId, node });
      select(node.id);
      return { id: node.id, name: node.name };
    },
  }),

  addGroup: defineAppCommand({
    description: 'Add an empty group node, for organising a hierarchy.',
    params: z.object({ name: z.optional(z.string()), parentId: z.optional(z.string()) }),
    run: (p) => {
      const parentId = p.parentId ?? ROOT_ID;
      if (parentId !== ROOT_ID) requireNode(parentId);
      const node = createGroupNode(p.name ?? 'Group', newId('g'));
      mutate({ type: 'addNode', parentId, node });
      return { id: node.id, name: node.name };
    },
  }),

  setGeometryParams: defineAppCommand({
    description:
      'Change the parameters of a procedural primitive (e.g. { radius: 2, widthSegments: 64 }). ' +
      'Has no effect on imported buffer geometry.',
    params: z.object({ id: z.string(), params: z.record(z.string(), z.number()) }),
    run: (p) => {
      const node = requireNode(p.id);
      if (node.geometry?.type === 'buffer') {
        throw new AppCommandError(`"${node.name}" is imported mesh data, not a procedural primitive.`);
      }
      mutate({
        type: 'setGeometry',
        id: p.id,
        patch: { params: { ...(node.geometry?.params ?? {}), ...p.params } },
      });
      return { geometry: requireNode(p.id).geometry };
    },
  }),

  undo: defineAppCommand({
    description: 'Undo the last scene mutation.',
    replay: 'never',
    run: () => ({ ok: undo() }),
  }),

  redo: defineAppCommand({
    description: 'Redo the last undone mutation.',
    replay: 'never',
    run: () => ({ ok: redo() }),
  }),
};

export const viewCommands = {
  frameAll: defineAppCommand({
    description: 'Fit the camera to the whole scene.',
    run: () => ({ ok: frameAll() }),
  }),

  frameSelection: defineAppCommand({
    description: 'Fit the camera to the selected node (falls back to frame all).',
    run: () => ({ ok: frameSelection() }),
  }),

  toggleGrid: defineAppCommand({
    description: 'Toggle the ground grid and axes helper.',
    run: () => {
      setGrid(!gridOn());
      return { grid: gridOn() };
    },
  }),

  toggleWireframe: defineAppCommand({
    description: 'Toggle the global wireframe override.',
    run: () => {
      setWireframe(!wireframeOn());
      return { wireframe: wireframeOn() };
    },
  }),

  meshInfo: defineAppCommand({
    description: 'Live vertex/triangle counts for one mesh node, read from the rendered geometry.',
    params: z.object({ id: z.string() }),
    run: (p) => {
      requireNode(p.id);
      const counts = reconciler.meshCounts(p.id);
      if (!counts) throw new AppCommandError(`"${p.id}" is not a mesh.`);
      return counts;
    },
  }),
};
