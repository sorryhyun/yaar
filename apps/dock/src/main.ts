type DockItem = { id: string; label: string; icon: string };

const defaultItems: DockItem[] = [
  { id: 'word-lite', label: 'Word', icon: '📝' },
  { id: 'excel-lite', label: 'Excel', icon: '📊' },
  { id: 'browser', label: 'Browser', icon: '🌐' },
  { id: 'storage', label: 'Storage', icon: '🗂️' },
  { id: 'recent-papers', label: 'Papers', icon: '📄' },
  { id: 'slides-lite', label: 'Slides', icon: '📽️' },
];

let items = [...defaultItems];
let activeAppId: string | null = null;

const root = document.createElement('div');
root.id = 'dock-root';
document.body.appendChild(root);

const style = document.createElement('style');
style.textContent = `
  :root {
    color-scheme: dark;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  }
  body {
    margin: 0;
    background: #0a0b0d;
    color: #eef1f6;
  }
  #dock-root {
    display: flex;
    gap: 8px;
    padding: 8px;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
  }
  .dock-btn {
    border: 1px solid #2b313b;
    background: #141821;
    color: inherit;
    border-radius: 12px;
    padding: 8px 10px;
    min-width: 76px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    transition: border-color .12s ease, transform .12s ease;
  }
  .dock-btn:hover {
    border-color: #4b5563;
    transform: translateY(-1px);
  }
  .dock-btn.active {
    border-color: #22c55e;
    box-shadow: 0 0 0 1px #22c55e33 inset;
  }
  .icon {
    font-size: 20px;
    line-height: 1;
  }
  .label {
    font-size: 12px;
  }
`;
document.head.appendChild(style);

function render() {
  root.innerHTML = '';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = `dock-btn${item.id === activeAppId ? ' active' : ''}`;
    btn.setAttribute('type', 'button');
    btn.innerHTML = `<span class="icon">${item.icon}</span><span class="label">${item.label}</span>`;

    btn.addEventListener('click', () => {
      activeAppId = item.id;
      render();
      const msg = `<user_interaction:click>app: ${item.id}</user_interaction:click>`;
      (window as any).yaar?.app?.sendInteraction?.(msg);
    });

    root.appendChild(btn);
  }
}

render();

const appApi = (window as any).yaar?.app;
if (appApi) {
  appApi.register({
    appId: 'dock',
    name: 'Dock',
    state: {
      items: {
        description: 'Dock items currently displayed',
        handler: () => [...items],
      },
      activeAppId: {
        description: 'Most recently launched app id from dock',
        handler: () => activeAppId,
      },
    },
    commands: {
      setItems: {
        description: 'Replace dock items. Params: { items: {id,label,icon}[] }',
        params: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  icon: { type: 'string' },
                },
                required: ['id', 'label', 'icon'],
              },
            },
          },
          required: ['items'],
        },
        handler: (p: { items: DockItem[] }) => {
          items = [...(p.items || [])];
          render();
          return { ok: true, count: items.length };
        },
      },
      setActiveApp: {
        description: 'Mark one app as active. Params: { appId: string | null }',
        params: {
          type: 'object',
          properties: {
            appId: { type: ['string', 'null'] },
          },
          required: ['appId'],
        },
        handler: (p: { appId: string | null }) => {
          activeAppId = p.appId;
          render();
          return { ok: true };
        },
      },
    },
  });
}
