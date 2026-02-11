import * as THREE from '@bundled/three';

export type BlockDef = { name: string; color: string; placeable: boolean; emissive?: string };

export type WorldContext = {
  WORLD_X: number;
  WORLD_Z: number;
  MAX_H: number;
  defs: Record<number, BlockDef>;
  worldGroup: any;
  getBlock: (x: number, y: number, z: number) => number;
  setBlock: (x: number, y: number, z: number, id: number) => void;
  getTopY: (x: number, z: number) => number;
};

export function createWorld(scene: any): WorldContext {
  const worldGroup = new THREE.Group();
  scene.add(worldGroup);

  const WORLD_X = 44;
  const WORLD_Z = 44;
  const MAX_H = 16;

  const defs: Record<number, BlockDef> = {
    1: { name: 'Grass', color: '#4caf50', placeable: true },
    2: { name: 'Dirt', color: '#8d6e63', placeable: true },
    3: { name: 'Stone', color: '#9e9e9e', placeable: true },
    4: { name: 'Log', color: '#8b5a2b', placeable: true },
    5: { name: 'Planks', color: '#c89d65', placeable: true },
    6: { name: 'Glass', color: '#b3e5fc', placeable: true },
    7: { name: 'Sand', color: '#e8d89f', placeable: true },
    8: { name: 'Snow', color: '#f5f5f5', placeable: true },
    9: { name: 'Lamp', color: '#ffcc66', emissive: '#ffb300', placeable: true }
  };

  const rng = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  function hexToRgb(hex: string) {
    const v = hex.replace('#', '');
    const n = parseInt(v, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function shade(hex: string, amount: number) {
    const { r, g, b } = hexToRgb(hex);
    const clamp = (x: number) => Math.max(0, Math.min(255, Math.round(x)));
    return `rgb(${clamp(r + amount)}, ${clamp(g + amount)}, ${clamp(b + amount)})`;
  }

  function makeBlockTexture(id: number, base: string) {
    const size = 32;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    if (!ctx) return null;

    const rand = rng(id * 1337 + 42);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);

    const dotCount = id === 6 ? 18 : 120;
    for (let i = 0; i < dotCount; i++) {
      const x = Math.floor(rand() * size);
      const y = Math.floor(rand() * size);
      const s = id === 6 ? 1 : (rand() > 0.9 ? 2 : 1);
      const v = (rand() - 0.5) * (id === 7 ? 30 : id === 3 ? 60 : 42);
      ctx.fillStyle = shade(base, v);
      ctx.fillRect(x, y, s, s);
    }

    if (id === 4 || id === 5) {
      for (let y = 0; y < size; y += 5) {
        ctx.fillStyle = shade(base, -22 + (y % 10 ? 0 : 10));
        ctx.fillRect(0, y, size, 1);
      }
    }

    if (id === 6) {
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      for (let i = 0; i < 4; i++) {
        const x = 3 + i * 7;
        ctx.beginPath();
        ctx.moveTo(x, 1);
        ctx.lineTo(x + 2, size - 2);
        ctx.stroke();
      }
    }

    if (id === 9) {
      const g = ctx.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2);
      g.addColorStop(0, 'rgba(255,255,220,0.95)');
      g.addColorStop(1, 'rgba(255,170,40,0.7)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }

    const tex: any = new (THREE as any).CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  const mats: Record<number, any> = {};
  for (const [k, d] of Object.entries(defs)) {
    const id = Number(k);
    const map = makeBlockTexture(id, d.color);
    mats[id] = new THREE.MeshStandardMaterial({
      color: d.color,
      map: map || undefined,
      transparent: id === 6,
      opacity: id === 6 ? 0.45 : 1,
      roughness: id === 6 ? 0.12 : id === 9 ? 0.55 : 0.9,
      metalness: id === 9 ? 0.08 : 0.0,
      emissive: d.emissive ? new THREE.Color(d.emissive) : new THREE.Color('#000000'),
      emissiveIntensity: d.emissive ? 0.7 : 0
    });
  }

  const geo = new THREE.BoxGeometry(1, 1, 1);
  const blocks = new Map<string, number>();
  const meshes = new Map<string, any>();
  const lamps = new Map<string, any>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

  function getBlock(x: number, y: number, z: number) {
    return blocks.get(key(x, y, z)) || 0;
  }

  function setBlock(x: number, y: number, z: number, id: number) {
    if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z || y < 0 || y > MAX_H) return;
    const k = key(x, y, z);

    const ex = meshes.get(k);
    if (ex) {
      worldGroup.remove(ex);
      meshes.delete(k);
    }

    const lamp = lamps.get(k);
    if (lamp) {
      scene.remove(lamp);
      lamps.delete(k);
    }

    if (!id) {
      blocks.delete(k);
      return;
    }

    blocks.set(k, id);
    const m = new THREE.Mesh(geo, mats[id]);
    m.position.set(x + 0.5, y + 0.5, z + 0.5);
    (m as any).castShadow = true;
    (m as any).receiveShadow = true;
    m.userData.blockPos = { x, y, z };
    worldGroup.add(m);
    meshes.set(k, m);

    if (id === 9) {
      const p = new THREE.PointLight(0xffc766, 0.65, 9, 2);
      p.position.set(x + 0.5, y + 0.8, z + 0.5);
      scene.add(p);
      lamps.set(k, p);
    }
  }

  function surfaceHeight(x: number, z: number) {
    const nx = x / WORLD_X;
    const nz = z / WORLD_Z;
    const hill = Math.sin(nx * Math.PI * 3.4) * 2.2 + Math.cos(nz * Math.PI * 4.0) * 1.8;
    const detail = Math.sin((x + z) * 0.35) * 0.8 + Math.cos((x - z) * 0.25) * 0.7;
    const n = 6 + hill + detail + Math.random() * 1.3;
    return Math.max(3, Math.min(MAX_H - 3, Math.floor(n)));
  }

  function biomeAt(x: number, z: number) {
    const v = Math.sin(x * 0.12) + Math.cos(z * 0.17) + Math.sin((x + z) * 0.05);
    if (v > 1.2) return 'snow';
    if (v < -1.0) return 'desert';
    return 'forest';
  }

  for (let x = 0; x < WORLD_X; x++) {
    for (let z = 0; z < WORLD_Z; z++) {
      const top = surfaceHeight(x, z);
      const biome = biomeAt(x, z);

      for (let y = 0; y <= top; y++) {
        let id = 3;
        if (y === top) id = biome === 'desert' ? 7 : biome === 'snow' ? 8 : 1;
        else if (y > top - 2) id = biome === 'desert' ? 7 : 2;
        setBlock(x, y, z, id);
      }

      if (biome === 'forest' && Math.random() < 0.06 && x > 2 && z > 2 && x < WORLD_X - 2 && z < WORLD_Z - 2) {
        const base = top + 1;
        const h = 2 + Math.floor(Math.random() * 3);
        for (let t = 0; t < h; t++) setBlock(x, base + t, z, 4);
        for (let lx = -1; lx <= 1; lx++) {
          for (let lz = -1; lz <= 1; lz++) if (Math.random() < 0.8) setBlock(x + lx, base + h, z + lz, 1);
        }
      }
    }
  }

  for (let i = 0; i < 14; i++) {
    const cx = 4 + Math.floor(Math.random() * (WORLD_X - 8));
    const cy = 3 + Math.floor(Math.random() * (MAX_H - 7));
    const cz = 4 + Math.floor(Math.random() * (WORLD_Z - 8));
    const r = 2 + Math.floor(Math.random() * 3);
    for (let x = cx - r; x <= cx + r; x++) {
      for (let y = cy - r; y <= cy + r; y++) {
        for (let z = cz - r; z <= cz + r; z++) {
          const d = Math.hypot(x - cx, y - cy, z - cz);
          if (d <= r + Math.random() * 0.7) setBlock(x, y, z, 0);
        }
      }
    }
  }

  const water = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), new THREE.MeshStandardMaterial({
    color: '#5fa1df',
    transparent: true,
    opacity: 0.5,
    roughness: 0.25,
    metalness: 0.1
  }));
  water.rotation.x = -Math.PI / 2;
  water.position.y = 3.2;
  scene.add(water);

  function getTopY(x: number, z: number) {
    for (let y = MAX_H; y >= 0; y--) if (getBlock(x, y, z) !== 0) return y;
    return 0;
  }

  return { WORLD_X, WORLD_Z, MAX_H, defs, worldGroup, getBlock, setBlock, getTopY };
}
