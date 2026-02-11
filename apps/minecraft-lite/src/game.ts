import * as THREE from '@bundled/three';
import { BASE_MESSAGE, createUI } from './ui';
import { createWorld } from './world';

export function startGame(root: HTMLElement) {

  const ui = createUI(root);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  root.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#87ceeb');
  scene.fog = new THREE.Fog('#87ceeb', 25, 100);

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 300);

  const ambient = new THREE.AmbientLight(0xffffff, 0.52);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(30, 50, 10);
  sun.castShadow = true;
  scene.add(sun);

  const world = createWorld(scene);
  const { WORLD_X, WORLD_Z, MAX_H, defs, worldGroup, getBlock, setBlock, getTopY } = world;

  const mobGroup = new THREE.Group();
  scene.add(mobGroup);

  const player = {
    pos: new THREE.Vector3(WORLD_X / 2, 14, WORLD_Z / 2),
    vel: new THREE.Vector3(),
    radius: 0.3,
    height: 1.8,
    onGround: false,
    yaw: 0,
    pitch: 0,
    health: 100,
    hunger: 100,
    hurtTimer: 0
  };

  const hotbarSlots = [1, 2, 3, 4, 5, 6, 9];
  let selectedSlot = 0;
  const inventory: Record<number, number> = { 1: 20, 2: 20, 3: 20, 4: 12, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };

  const recipes = [
    { id: 'planks', outId: 5, out: 4, costs: [{ id: 4, n: 1 }], label: '1 Log -> 4 Planks' },
    { id: 'glass', outId: 6, out: 1, costs: [{ id: 7, n: 2 }], label: '2 Sand -> 1 Glass' },
    { id: 'lamp', outId: 9, out: 2, costs: [{ id: 5, n: 2 }, { id: 4, n: 1 }], label: '2 Planks + 1 Log -> 2 Lamps' }
  ];

  const selectedBlockId = () => hotbarSlots[selectedSlot];

  function collides(px: number, py: number, pz: number) {
    const minX = px - player.radius;
    const maxX = px + player.radius;
    const minY = py;
    const maxY = py + player.height;
    const minZ = pz - player.radius;
    const maxZ = pz + player.radius;
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
    if (!collides(next.x, next.y, next.z)) {
      player.pos.copy(next);
      return;
    }

    const step = Math.sign(amount) * 0.02;
    let moved = 0;
    while (Math.abs(moved + step) <= Math.abs(amount)) {
      const t = player.pos.clone();
      t[axis] += moved + step;
      if (collides(t.x, t.y, t.z)) break;
      moved += step;
    }
    player.pos[axis] += moved;
    if (axis === 'y') {
      if (amount < 0) player.onGround = true;
      player.vel.y = 0;
    }
    if (axis === 'x') player.vel.x = 0;
    if (axis === 'z') player.vel.z = 0;
  }

  const keys = new Set<string>();
  let panelOpen = false;

  const canCraft = (recipe: { costs: { id: number; n: number }[] }) => recipe.costs.every(c => (inventory[c.id] || 0) >= c.n);

  function renderPanel() {
    if (!panelOpen) return;
    const invRows = Object.keys(defs)
      .map(k => Number(k))
      .map(id => `<div style="display:flex;justify-content:space-between;padding:3px 0;"><span>${defs[id].name}</span><b>${inventory[id] || 0}</b></div>`)
      .join('');

    const craftRows = recipes
      .map((r, idx) => {
        const ok = canCraft(r);
        return `<button data-r="${idx}" ${ok ? '' : 'disabled'} style="width:100%;margin-top:6px;padding:7px;border-radius:8px;border:1px solid #666;background:${ok ? '#2d6cdf' : '#444'};color:#fff;cursor:${ok ? 'pointer' : 'default'}">${r.label}</button>`;
      })
      .join('');

    ui.panel.innerHTML = `
      <div style="font-weight:700;font-size:16px;margin-bottom:8px;">Inventory & Crafting</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div style="background:rgba(255,255,255,0.06);padding:8px;border-radius:8px;">
          <div style="opacity:.85;margin-bottom:4px;">Items</div>
          ${invRows}
        </div>
        <div style="background:rgba(255,255,255,0.06);padding:8px;border-radius:8px;">
          <div style="opacity:.85;margin-bottom:4px;">Recipes</div>
          ${craftRows}
        </div>
      </div>
      <div style="margin-top:10px;opacity:0.8;font-size:12px;">Press E to close inventory.</div>
    `;

    ui.panel.querySelectorAll('button[data-r]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number((btn as HTMLElement).getAttribute('data-r'));
        const r = recipes[i];
        if (!canCraft(r)) return;
        r.costs.forEach(c => inventory[c.id] -= c.n);
        inventory[r.outId] = (inventory[r.outId] || 0) + r.out;
        showToast(`Crafted ${r.out} ${defs[r.outId].name}`);
        renderPanel();
      });
    });
  }

  function setPanel(open: boolean) {
    panelOpen = open;
    ui.panel.style.display = open ? 'block' : 'none';
    if (open) {
      document.exitPointerLock?.();
      ui.center.style.display = 'none';
      renderPanel();
    } else ui.center.style.display = 'block';
  }

  function showToast(text: string) {
    ui.msg.textContent = text;
    setTimeout(() => {
      ui.msg.textContent = BASE_MESSAGE;
    }, 1700);
  }

  function renderHotbar() {
    ui.hotbar.innerHTML = '';
    hotbarSlots.forEach((id, i) => {
      const slot = document.createElement('div');
      const active = i === selectedSlot;
      Object.assign(slot.style, {
        width: '72px',
        height: '54px',
        borderRadius: '9px',
        border: active ? '2px solid #fff' : '1px solid rgba(255,255,255,0.45)',
        background: active ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.4)',
        color: '#fff',
        fontSize: '12px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '5px',
        boxSizing: 'border-box'
      });
      slot.innerHTML = `<div>${i + 1}: ${defs[id].name}</div><b style="text-align:right">${inventory[id] || 0}</b>`;
      ui.hotbar.appendChild(slot);
    });
  }

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'e') return setPanel(!panelOpen);
    if (panelOpen) return;

    keys.add(k);
    if (k >= '1' && k <= String(hotbarSlots.length)) {
      selectedSlot = Number(k) - 1;
      renderHotbar();
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  renderer.domElement.addEventListener('click', () => {
    if (!panelOpen) renderer.domElement.requestPointerLock();
  });

  window.addEventListener('mousemove', (e) => {
    if (panelOpen || document.pointerLockElement !== renderer.domElement) return;
    player.yaw -= e.movementX * 0.0022;
    player.pitch -= e.movementY * 0.0022;
    player.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, player.pitch));
  });

  const mobs: { mesh: any; hp: number; speed: number; hitCd: number }[] = [];
  const mobGeo = new THREE.BoxGeometry(0.8, 1.5, 0.8);
  const mobMat = new THREE.MeshStandardMaterial({ color: '#8b1e1e' });

  function spawnMob() {
    for (let tries = 0; tries < 20; tries++) {
      const x = Math.floor(Math.random() * WORLD_X);
      const z = Math.floor(Math.random() * WORLD_Z);
      const dist = Math.hypot(x + 0.5 - player.pos.x, z + 0.5 - player.pos.z);
      if (dist < 10 || dist > 28) continue;
      const y = getTopY(x, z) + 1;
      const m = new THREE.Mesh(mobGeo, mobMat);
      m.position.set(x + 0.5, y + 0.75, z + 0.5);
      (m as any).castShadow = true;
      (m as any).receiveShadow = true;
      mobGroup.add(m);
      mobs.push({ mesh: m, hp: 4, speed: 1.4 + Math.random() * 0.4, hitCd: 0 });
      return;
    }
  }

  function updateMobs(dt: number) {
    for (let i = mobs.length - 1; i >= 0; i--) {
      const mob = mobs[i];
      const pos = mob.mesh.position;
      const to = new THREE.Vector3(player.pos.x - pos.x, 0, player.pos.z - pos.z);
      const d = to.length();
      if (d > 0.001) to.multiplyScalar(1 / d);

      const nx = pos.x + to.x * mob.speed * dt;
      const nz = pos.z + to.z * mob.speed * dt;
      const gx = Math.floor(nx);
      const gz = Math.floor(nz);
      const gy = getTopY(Math.max(0, Math.min(WORLD_X - 1, gx)), Math.max(0, Math.min(WORLD_Z - 1, gz))) + 1;

      pos.x = nx;
      pos.z = nz;
      pos.y += (gy + 0.75 - pos.y) * Math.min(1, dt * 8);

      mob.hitCd -= dt;
      if (d < 1.25 && mob.hitCd <= 0) {
        player.health = Math.max(0, player.health - 8);
        player.hurtTimer = 0.35;
        mob.hitCd = 0.8;
      }

      if (mob.hp <= 0) {
        mobGroup.remove(mob.mesh);
        mobs.splice(i, 1);
      }
    }
  }

  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
  renderer.domElement.addEventListener('mousedown', (e) => {
    if (panelOpen) return;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(0, 0), camera);

    if (e.button === 0) {
      const mobHit = ray.intersectObjects(mobGroup.children, false)[0];
      if (mobHit && mobHit.distance <= 3.2) {
        const mob = mobs.find(m => m.mesh === mobHit.object);
        if (mob) {
          mob.hp -= 1;
          showToast('Hit!');
        }
        return;
      }
    }

    const hits = ray.intersectObjects(worldGroup.children, false);
    if (!hits.length) return;

    const hit = hits[0];
    const p = (hit.object as any)?.userData?.blockPos as { x: number; y: number; z: number } | undefined;
    if (!p || hit.distance > 7) return;

    if (e.button === 0) {
      const id = getBlock(p.x, p.y, p.z);
      if (id !== 0) inventory[id] = (inventory[id] || 0) + 1;
      setBlock(p.x, p.y, p.z, 0);
      renderHotbar();
      if (panelOpen) renderPanel();
    } else if (e.button === 2) {
      const b = selectedBlockId();
      if ((inventory[b] || 0) <= 0) return showToast(`No ${defs[b].name} left`);
      const n = ((hit.face as any)?.normal as { x: number; y: number; z: number } | undefined) || new THREE.Vector3();
      const ax = p.x + Math.round(n.x), ay = p.y + Math.round(n.y), az = p.z + Math.round(n.z);
      if (getBlock(ax, ay, az) === 0 && !collides(ax + 0.5, ay, az + 0.5)) {
        setBlock(ax, ay, az, b);
        inventory[b] -= 1;
        renderHotbar();
        if (panelOpen) renderPanel();
      }
    }
  });

  function updateHud(dayT: number) {
    const blockId = selectedBlockId();
    const hp = Math.max(0, Math.floor(player.health));
    const hunger = Math.max(0, Math.floor(player.hunger));
    const phase = dayT > 0.22 && dayT < 0.78 ? 'Day' : 'Night';
    ui.hud.textContent = `Minecraft 3D Lite+\nHP: ${hp}   Hunger: ${hunger}   ${phase}\nBlock: ${defs[blockId].name} (${inventory[blockId] || 0})\nXYZ: ${player.pos.x.toFixed(1)}, ${player.pos.y.toFixed(1)}, ${player.pos.z.toFixed(1)}\nMobs: ${mobs.length}`;
    ui.hud.style.outline = player.hurtTimer > 0 ? '2px solid rgba(255,90,90,0.9)' : 'none';
  }

  renderHotbar();

  let dayClock = 0.3;
  let mobSpawnTimer = 0;
  let prev = performance.now();

  function tick(now: number) {
    const dt = Math.min(0.033, (now - prev) / 1000);
    prev = now;

    dayClock = (dayClock + dt / 210) % 1;
    const sunA = dayClock * Math.PI * 2;
    const sunHeight = Math.sin(sunA);
    sun.position.set(Math.cos(sunA) * 44, 34 + sunHeight * 32, Math.sin(sunA) * 34);
    sun.intensity = Math.max(0.08, 0.25 + Math.max(0, sunHeight) * 1.0);
    ambient.intensity = 0.15 + Math.max(0, sunHeight) * 0.45;

    const dayColor = new THREE.Color('#87ceeb');
    const nightColor = new THREE.Color('#0f1728');
    const t = Math.max(0, 1 - Math.max(0, sunHeight + 0.05) * 1.4);
    const blend = t * 0.9;
    const bg = dayColor.clone();
    (bg as any).r = dayColor.r + (nightColor.r - dayColor.r) * blend;
    (bg as any).g = dayColor.g + (nightColor.g - dayColor.g) * blend;
    (bg as any).b = dayColor.b + (nightColor.b - dayColor.b) * blend;
    scene.background = bg;
    scene.fog.color = bg.clone();

    if (!panelOpen) {
      const forward = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
      const right = new THREE.Vector3(-forward.z, 0, forward.x);
      const wish = new THREE.Vector3();
      if (keys.has('w')) wish.add(forward);
      if (keys.has('s')) wish.sub(forward);
      if (keys.has('d')) wish.add(right);
      if (keys.has('a')) wish.sub(right);

      if (wish.length() > 0) {
        wish.normalize().multiplyScalar(6.3);
        player.vel.x += (wish.x - player.vel.x) * Math.min(1, dt * 14);
        player.vel.z += (wish.z - player.vel.z) * Math.min(1, dt * 14);
        player.hunger = Math.max(0, player.hunger - dt * 0.95);
      } else {
        player.vel.x *= Math.pow(0.0001, dt);
        player.vel.z *= Math.pow(0.0001, dt);
        player.hunger = Math.max(0, player.hunger - dt * 0.18);
      }

      if (keys.has(' ') && player.onGround) {
        player.vel.y = 7.5;
        player.onGround = false;
      }
    }

    player.vel.y -= 18 * dt;
    player.onGround = false;

    moveAxis('x', player.vel.x * dt);
    moveAxis('z', player.vel.z * dt);
    moveAxis('y', player.vel.y * dt);

    if (player.pos.y < -20 || player.health <= 0) {
      player.pos.set(WORLD_X / 2, 15, WORLD_Z / 2);
      player.vel.set(0, 0, 0);
      player.health = 100;
      player.hunger = 75;
      showToast('You respawned.');
    }

    if (player.hunger <= 0) player.health = Math.max(0, player.health - dt * 3.2);
    else if (player.hunger > 70 && player.health < 100) player.health = Math.min(100, player.health + dt * 1.8);

    const isNight = dayClock <= 0.20 || dayClock >= 0.78;
    mobSpawnTimer -= dt;
    if (isNight && mobSpawnTimer <= 0 && mobs.length < 8) {
      spawnMob();
      mobSpawnTimer = 2.8;
    }

    updateMobs(dt);
    player.hurtTimer = Math.max(0, player.hurtTimer - dt);

    camera.position.set(player.pos.x, player.pos.y + 1.62, player.pos.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.y = player.yaw;
    camera.rotation.x = player.pitch;

    updateHud(dayClock);
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
