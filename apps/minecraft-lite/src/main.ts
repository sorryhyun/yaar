const root = (document.getElementById('app') as HTMLDivElement | null) ?? document.body;
root.innerHTML = '';
Object.assign(root.style, {
  margin: '0',
  width: '100vw',
  height: '100vh',
  overflow: 'hidden',
  background: '#87ceeb',
  fontFamily: 'system-ui, sans-serif',
});

const wrap = document.createElement('div');
Object.assign(wrap.style, {
  width: '100%',
  height: '100%',
  display: 'grid',
  placeItems: 'center',
});

const canvas = document.createElement('canvas');
canvas.width = 960;
canvas.height = 540;
Object.assign(canvas.style, {
  width: 'min(96vw, 1200px)',
  aspectRatio: '16 / 9',
  borderRadius: '12px',
  boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
  background: '#8ec9ff',
});

const hud = document.createElement('div');
Object.assign(hud.style, {
  position: 'fixed',
  top: '12px',
  left: '12px',
  color: '#fff',
  background: 'rgba(0,0,0,0.4)',
  borderRadius: '8px',
  padding: '8px 10px',
  whiteSpace: 'pre-line',
  fontSize: '13px',
});

const tip = document.createElement('div');
Object.assign(tip.style, {
  position: 'fixed',
  bottom: '14px',
  left: '50%',
  transform: 'translateX(-50%)',
  color: '#fff',
  background: 'rgba(0,0,0,0.45)',
  borderRadius: '999px',
  padding: '8px 12px',
  fontSize: '12px',
});
tip.textContent = 'WASD: move • Space: jump • R: restart';

wrap.appendChild(canvas);
root.appendChild(wrap);
root.appendChild(hud);
root.appendChild(tip);

const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('Canvas 2D not supported');

type Block = { x: number; y: number; w: number; h: number; color: string };
const blocks: Block[] = [];
for (let i = 0; i < 60; i++) {
  const x = i * 32;
  const h = 120 + Math.floor(Math.sin(i * 0.35) * 24 + Math.random() * 20);
  blocks.push({ x, y: canvas.height - h, w: 32, h, color: i % 2 ? '#67b85f' : '#5baa56' });
}

const player = { x: 120, y: 220, vx: 0, vy: 0, w: 26, h: 42, onGround: false, hp: 100 };
const keys = new Set<string>();

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  keys.add(k);
  if (k === 'r') {
    player.x = 120;
    player.y = 220;
    player.vx = 0;
    player.vy = 0;
    player.hp = 100;
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

function collideY(nx: number, ny: number) {
  for (const b of blocks) {
    if (nx + player.w <= b.x || nx >= b.x + b.w) continue;
    if (ny + player.h <= b.y || ny >= b.y + b.h) continue;
    return b;
  }
  return null;
}

let last = performance.now();
function tick(now: number) {
  const dt = Math.min(0.033, (now - last) / 1000);
  last = now;

  const accel = keys.has('a') ? -900 : keys.has('d') ? 900 : 0;
  if (accel) player.vx += accel * dt;
  else player.vx *= Math.pow(0.0008, dt);

  player.vx = Math.max(-220, Math.min(220, player.vx));
  if (keys.has(' ') && player.onGround) {
    player.vy = -420;
    player.onGround = false;
  }

  player.vy += 980 * dt;

  player.x += player.vx * dt;
  player.y += player.vy * dt;

  player.onGround = false;
  const hit = collideY(player.x, player.y);
  if (hit) {
    if (player.vy > 0) {
      player.y = hit.y - player.h;
      player.vy = 0;
      player.onGround = true;
    } else if (player.vy < 0) {
      player.y = hit.y + hit.h;
      player.vy = 0;
    }
  }

  if (player.y > canvas.height + 120) {
    player.x = 120;
    player.y = 220;
    player.vx = 0;
    player.vy = 0;
    player.hp = Math.max(0, player.hp - 10);
  }

  const camX = Math.max(0, player.x - canvas.width * 0.35);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#8ec9ff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#fdf6d0';
  ctx.beginPath();
  ctx.arc(90, 80, 30, 0, Math.PI * 2);
  ctx.fill();

  for (const b of blocks) {
    const sx = b.x - camX;
    if (sx + b.w < 0 || sx > canvas.width) continue;
    ctx.fillStyle = b.color;
    ctx.fillRect(sx, b.y, b.w, b.h);
    ctx.fillStyle = '#7a5a3a';
    ctx.fillRect(sx, b.y + 6, b.w, 2);
  }

  const px = player.x - camX;
  ctx.fillStyle = '#2f2f2f';
  ctx.fillRect(px, player.y, player.w, player.h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(px + 16, player.y + 9, 5, 5);

  hud.textContent = `Minecraft Lite (2D safe mode)\nHP: ${Math.floor(player.hp)}\nX: ${player.x.toFixed(1)}  Y: ${player.y.toFixed(1)}`;

  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
