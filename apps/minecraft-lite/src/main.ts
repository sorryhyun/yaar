import { startGame } from './game';

const root = document.getElementById('app') || document.body;
root.innerHTML = '';
Object.assign(root.style, {
  margin: '0',
  width: '100vw',
  height: '100vh',
  overflow: 'hidden',
  background: '#87ceeb',
  fontFamily: 'system-ui, sans-serif'
});

try {
  startGame(root);
} catch (err) {
  const pre = document.createElement('pre');
  pre.textContent = `Failed to load 3D engine: ${String(err)}`;
  pre.style.color = 'white';
  pre.style.padding = '12px';
  root.appendChild(pre);
}
