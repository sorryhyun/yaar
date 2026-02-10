const root = document.getElementById('app') || document.body;
root.innerHTML = '';
Object.assign(root.style, {
  margin: '0', width: '100vw', height: '100vh', overflow: 'hidden', background: '#87ceeb', fontFamily: 'system-ui, sans-serif'
});

const hud = document.createElement('div');
Object.assign(hud.style, {
  position: 'fixed', top: '10px', left: '10px', color: 'white', background: 'rgba(0,0,0,0.45)',
  padding: '8px 10px', fontSize: '13px', borderRadius: '8px', zIndex: '10'
});
root.appendChild(hud);

const center = document.createElement('div');
Object.assign(center.style, {
  position: 'fixed', left: '50%', top: '50%', width: '14px', height: '14px', transform: 'translate(-50%, -50%)',
  pointerEvents: 'none', zIndex: '10', color: '#fff'
});
center.textContent = '+';
root.appendChild(center);

const msg = document.createElement('div');
Object.assign(msg.style, {
  position: 'fixed', bottom: '12px', left: '10px', color: '#fff', background: 'rgba(0,0,0,0.45)',
  padding: '6px 10px', fontSize: '12px', borderRadius: '8px', zIndex: '10'
});
msg.textContent = 'Click to lock mouse. WASD move, Space jump, LMB break, RMB place, 1-4 block.';
root.appendChild(msg);

async function boot() {
  const THREE: any = await import('https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js');

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  root.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#87ceeb');
  scene.fog = new THREE.Fog('#87ceeb', 25, 100);

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 300);
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));

  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(30, 50, 10);
  sun.castShadow = true;
  scene.add(sun);

  const worldGroup = new THREE.Group();
  scene.add(worldGroup);

  const WORLD_X = 40, WORLD_Z = 40, MAX_H = 12;
  let selected = 1;
  const names: Record<number, string> = { 1: 'Grass', 2: 'Dirt', 3: 'Stone', 4: 'Wood' };

  const mats: Record<number, any> = {
    1: new THREE.MeshStandardMaterial({ color: '#4caf50' }),
    2: new THREE.MeshStandardMaterial({ color: '#8d6e63' }),
    3: new THREE.MeshStandardMaterial({ color: '#9e9e9e' }),
    4: new THREE.MeshStandardMaterial({ color: '#8b5a2b' }),
  };
  const geo = new THREE.BoxGeometry(1, 1, 1);

  const blocks = new Map<string, number>();
  const meshes = new Map<string, any>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

  function getBlock(x: number, y: number, z: number) { return blocks.get(key(x, y, z)) || 0; }
  function setBlock(x: number, y: number, z: number, id: number) {
    if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z || y < 0 || y > MAX_H) return;
    const k = key(x, y, z);
    const ex = meshes.get(k);
    if (ex) { worldGroup.remove(ex); meshes.delete(k); }
    if (!id) { blocks.delete(k); return; }
    blocks.set(k, id);
    const m = new THREE.Mesh(geo, mats[id]);
    m.position.set(x + 0.5, y + 0.5, z + 0.5);
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.blockPos = { x, y, z };
    worldGroup.add(m);
    meshes.set(k, m);
  }

  for (let x = 0; x < WORLD_X; x++) {
    for (let z = 0; z < WORLD_Z; z++) {
      const h = 4 + Math.floor((Math.sin(x * 0.35) + Math.cos(z * 0.28)) * 1.7 + Math.random() * 1.2);
      const top = Math.max(2, Math.min(MAX_H - 2, h));
      for (let y = 0; y <= top; y++) setBlock(x, y, z, y === top ? 1 : y > top - 2 ? 2 : 3);
      if (Math.random() < 0.04 && x > 2 && z > 2 && x < WORLD_X - 2 && z < WORLD_Z - 2) {
        const base = top + 1, height = 2 + Math.floor(Math.random() * 2);
        for (let t = 0; t < height; t++) setBlock(x, base + t, z, 4);
      }
    }
  }

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), new THREE.MeshStandardMaterial({ color: '#6ca0dc' }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.01;
  floor.receiveShadow = true;
  scene.add(floor);

  const player = { pos: new THREE.Vector3(WORLD_X / 2, 12, WORLD_Z / 2), vel: new THREE.Vector3(), radius: 0.3, height: 1.8, onGround: false, yaw: 0, pitch: 0 };

  function collides(px: number, py: number, pz: number) {
    const minX = px - player.radius, maxX = px + player.radius;
    const minY = py, maxY = py + player.height;
    const minZ = pz - player.radius, maxZ = pz + player.radius;
    for (let x = Math.floor(minX); x <= Math.floor(maxX); x++) {
      for (let y = Math.floor(minY); y <= Math.floor(maxY); y++) {
        for (let z = Math.floor(minZ); z <= Math.floor(maxZ); z++) {
          if (getBlock(x, y, z) !== 0) return true;
        }
      }
    }
    return false;
  }

  function moveAxis(axis: 'x' | 'y' | 'z', amount: number) {
    if (!amount) return;
    const next = player.pos.clone();
    next[axis] += amount;
    if (!collides(next.x, next.y, next.z)) { player.pos.copy(next); return; }

    const step = Math.sign(amount) * 0.02;
    let moved = 0;
    while (Math.abs(moved + step) <= Math.abs(amount)) {
      const t = player.pos.clone();
      t[axis] += moved + step;
      if (collides(t.x, t.y, t.z)) break;
      moved += step;
    }
    player.pos[axis] += moved;
    if (axis === 'y') { if (amount < 0) player.onGround = true; player.vel.y = 0; }
    if (axis === 'x') player.vel.x = 0;
    if (axis === 'z') player.vel.z = 0;
  }

  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    keys.add(k);
    if (k >= '1' && k <= '4') selected = Number(k);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  renderer.domElement.addEventListener('click', () => renderer.domElement.requestPointerLock());
  window.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== renderer.domElement) return;
    player.yaw -= e.movementX * 0.0022;
    player.pitch -= e.movementY * 0.0022;
    player.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, player.pitch));
  });

  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
  renderer.domElement.addEventListener('mousedown', (e) => {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hits = ray.intersectObjects(worldGroup.children, false);
    if (!hits.length) return;

    const hit = hits[0];
    const p = hit.object.userData.blockPos;
    if (!p || hit.distance > 7) return;

    if (e.button === 0) {
      setBlock(p.x, p.y, p.z, 0);
    } else if (e.button === 2) {
      const n = hit.face?.normal || new THREE.Vector3();
      const ax = p.x + Math.round(n.x), ay = p.y + Math.round(n.y), az = p.z + Math.round(n.z);
      if (getBlock(ax, ay, az) === 0 && !collides(ax + 0.5, ay, az + 0.5)) setBlock(ax, ay, az, selected);
    }
  });

  function updateHud() {
    hud.textContent = `Minecraft 3D Lite | Block: ${selected} (${names[selected]}) | XYZ: ${player.pos.x.toFixed(1)}, ${player.pos.y.toFixed(1)}, ${player.pos.z.toFixed(1)}`;
  }

  let prev = performance.now();
  function tick(now: number) {
    const dt = Math.min(0.033, (now - prev) / 1000);
    prev = now;

    const forward = new THREE.Vector3(Math.sin(player.yaw), 0, Math.cos(player.yaw));
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    const wish = new THREE.Vector3();
    if (keys.has('w')) wish.add(forward);
    if (keys.has('s')) wish.sub(forward);
    if (keys.has('d')) wish.add(right);
    if (keys.has('a')) wish.sub(right);

    if (wish.lengthSq() > 0) {
      wish.normalize().multiplyScalar(6.5);
      player.vel.x += (wish.x - player.vel.x) * Math.min(1, dt * 14);
      player.vel.z += (wish.z - player.vel.z) * Math.min(1, dt * 14);
    } else {
      player.vel.x *= Math.pow(0.0001, dt);
      player.vel.z *= Math.pow(0.0001, dt);
    }

    if (keys.has(' ') && player.onGround) { player.vel.y = 7.5; player.onGround = false; }
    player.vel.y -= 18 * dt;
    player.onGround = false;

    moveAxis('x', player.vel.x * dt);
    moveAxis('z', player.vel.z * dt);
    moveAxis('y', player.vel.y * dt);

    if (player.pos.y < -20) { player.pos.set(WORLD_X / 2, 14, WORLD_Z / 2); player.vel.set(0, 0, 0); }

    camera.position.set(player.pos.x, player.pos.y + 1.62, player.pos.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.y = player.yaw;
    camera.rotation.x = player.pitch;

    updateHud();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

boot().catch((err) => {
  const pre = document.createElement('pre');
  pre.textContent = `Failed to load 3D engine: ${String(err)}`;
  pre.style.color = 'white';
  pre.style.padding = '12px';
  root.appendChild(pre);
});
