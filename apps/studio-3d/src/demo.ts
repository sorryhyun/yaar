/**
 * demo.ts — a small procedural scene built from core three geometries, so the
 * app is never a blank void. Everything here goes through applyOp, exactly
 * like a Phase 3 agent building geometry through the protocol would.
 */
import {
  applyOps,
  createEmptyDoc,
  createGroupNode,
  createMeshNode,
  defaultMaterial,
  newId,
  ROOT_ID,
  type MaterialDef,
  type SceneDoc,
  type SceneOp,
} from './scene-doc';

function mat(patch: Partial<MaterialDef>): MaterialDef {
  return { ...defaultMaterial(), ...patch };
}

export function buildDemoDoc(): SceneDoc {
  const propsId = newId('g');
  const props = createGroupNode('Props', propsId);

  const ground = createMeshNode(
    'Ground',
    { type: 'plane', params: { width: 9, height: 9, widthSegments: 1, heightSegments: 1 } },
    mat({ color: '#232a33', roughness: 0.95, metalness: 0, doubleSided: true }),
  );
  ground.transform.r.x = -90;
  ground.transform.p.y = -0.001;

  const knot = createMeshNode(
    'Torus Knot',
    { type: 'torusKnot', params: { radius: 0.85, tube: 0.26, tubularSegments: 160, radialSegments: 24, p: 2, q: 3 } },
    mat({ color: '#539bf5', metalness: 0.85, roughness: 0.22 }),
  );
  knot.transform.p = { x: 0, y: 1.25, z: 0 };

  const sphere = createMeshNode(
    'Sphere',
    { type: 'sphere', params: { radius: 0.75, widthSegments: 48, heightSegments: 32 } },
    mat({ color: '#e5534b', metalness: 0.15, roughness: 0.35 }),
  );
  sphere.transform.p = { x: -2.4, y: 0.75, z: 0.6 };

  const box = createMeshNode(
    'Box',
    { type: 'box', params: { width: 1.3, height: 1.3, depth: 1.3 } },
    mat({ color: '#57ab5a', metalness: 0.05, roughness: 0.6, flatShading: true }),
  );
  box.transform.p = { x: 2.3, y: 0.65, z: -0.8 };
  box.transform.r.y = 24;

  const cone = createMeshNode(
    'Cone',
    { type: 'cone', params: { radius: 0.6, height: 1.5, radialSegments: 40 } },
    mat({ color: '#c69026', metalness: 0.4, roughness: 0.45 }),
  );
  cone.transform.p = { x: 1.1, y: 0.75, z: 2.1 };

  const torus = createMeshNode(
    'Torus',
    { type: 'torus', params: { radius: 0.7, tube: 0.16, radialSegments: 20, tubularSegments: 64 } },
    mat({ color: '#adbac7', metalness: 0.9, roughness: 0.15 }),
  );
  torus.transform.p = { x: -1.6, y: 0.5, z: -2.2 };
  torus.transform.r.x = -70;

  const cylinder = createMeshNode(
    'Pedestal',
    { type: 'cylinder', params: { radiusTop: 1.4, radiusBottom: 1.6, height: 0.25, radialSegments: 64 } },
    mat({ color: '#39414c', metalness: 0.2, roughness: 0.8 }),
  );
  cylinder.transform.p = { x: 0, y: 0.125, z: 0 };

  const ops: SceneOp[] = [
    { type: 'addNode', parentId: ROOT_ID, node: ground },
    { type: 'addNode', parentId: ROOT_ID, node: cylinder },
    { type: 'addNode', parentId: ROOT_ID, node: knot },
    { type: 'addNode', parentId: ROOT_ID, node: props },
    { type: 'addNode', parentId: propsId, node: sphere },
    { type: 'addNode', parentId: propsId, node: box },
    { type: 'addNode', parentId: propsId, node: cone },
    { type: 'addNode', parentId: propsId, node: torus },
  ];

  const { doc } = applyOps(createEmptyDoc('Demo Studio'), ops);
  return doc;
}
