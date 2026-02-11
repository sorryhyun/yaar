export const BASE_MESSAGE = 'Click to lock mouse. WASD move, Space jump, LMB break/attack, RMB place, E inventory/crafting.';

export function createUI(root: HTMLElement) {
  const hud = document.createElement('div');
  Object.assign(hud.style, {
    position: 'fixed',
    top: '10px',
    left: '10px',
    color: 'white',
    background: 'rgba(0,0,0,0.45)',
    padding: '8px 10px',
    fontSize: '13px',
    borderRadius: '8px',
    zIndex: '20',
    whiteSpace: 'pre-line',
    maxWidth: 'min(360px, 90vw)'
  });
  root.appendChild(hud);

  const center = document.createElement('div');
  Object.assign(center.style, {
    position: 'fixed',
    left: '50%',
    top: '50%',
    width: '14px',
    height: '14px',
    transform: 'translate(-50%, -50%)',
    pointerEvents: 'none',
    zIndex: '20',
    color: '#fff'
  });
  center.textContent = '+';
  root.appendChild(center);

  const msg = document.createElement('div');
  Object.assign(msg.style, {
    position: 'fixed',
    bottom: '80px',
    left: '50%',
    transform: 'translateX(-50%)',
    color: '#fff',
    background: 'rgba(0,0,0,0.45)',
    padding: '6px 10px',
    fontSize: '12px',
    borderRadius: '8px',
    zIndex: '20',
    maxWidth: 'min(900px, 92vw)',
    textAlign: 'center',
    pointerEvents: 'none'
  });
  msg.textContent = BASE_MESSAGE;
  root.appendChild(msg);

  const hotbar = document.createElement('div');
  Object.assign(hotbar.style, {
    position: 'fixed',
    left: '50%',
    bottom: '14px',
    transform: 'translateX(-50%)',
    display: 'flex',
    gap: '6px',
    zIndex: '20',
    maxWidth: '96vw',
    flexWrap: 'wrap',
    justifyContent: 'center'
  });
  root.appendChild(hotbar);

  const panel = document.createElement('div');
  Object.assign(panel.style, {
    position: 'fixed',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    width: '420px',
    maxWidth: '92vw',
    maxHeight: '80vh',
    overflow: 'auto',
    background: 'rgba(20,20,20,0.92)',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: '12px',
    padding: '12px',
    color: '#fff',
    zIndex: '30',
    display: 'none'
  });
  root.appendChild(panel);

  return { hud, center, msg, hotbar, panel };
}
