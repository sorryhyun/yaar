const root = document.createElement('div');
root.id = 'dock-clock-root';
document.body.appendChild(root);

const style = document.createElement('style');
style.textContent = `
  :root {
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  }
  html, body {
    width: 100%;
    height: 100%;
    background: transparent;
  }
  body {
    margin: 0;
    color: #eef1f6;
  }
  #dock-clock-root {
    height: 100vh;
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    user-select: none;
    padding: 0 8px;
    box-sizing: border-box;
  }
  .panel {
    display: flex;
    flex-direction: row;
    align-items: baseline;
    justify-content: flex-end;
    gap: 8px;
    padding: 0;
    border-radius: 10px;
    background: rgba(10, 12, 16, 0.45);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 6px 30px rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .time {
    font-size: 24px;
    font-weight: 700;
    letter-spacing: 0.1px;
    line-height: 1;
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
    font-variant-numeric: tabular-nums;
  }
  .date {
    font-size: 16px;
    font-weight: 600;
    color: #d4dbe6;
    line-height: 1;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
`;
document.head.appendChild(style);

const panelEl = document.createElement('div');
panelEl.className = 'panel';

const timeEl = document.createElement('div');
timeEl.className = 'time';
const dateEl = document.createElement('div');
dateEl.className = 'date';
panelEl.appendChild(timeEl);
panelEl.appendChild(dateEl);
root.appendChild(panelEl);

const appearance = {
  showPanel: false,
  panelOpacity: 0.45,
  panelBlurPx: 10,
};

function applyAppearance() {
  panelEl.style.background = appearance.showPanel
    ? `rgba(10, 12, 16, ${appearance.panelOpacity})`
    : 'transparent';
  panelEl.style.border = appearance.showPanel
    ? '1px solid rgba(255, 255, 255, 0.12)'
    : '1px solid transparent';
  panelEl.style.boxShadow = appearance.showPanel
    ? '0 6px 30px rgba(0, 0, 0, 0.35)'
    : 'none';
  panelEl.style.backdropFilter = appearance.showPanel
    ? `blur(${appearance.panelBlurPx}px)`
    : 'none';
  (panelEl.style as any).webkitBackdropFilter = appearance.showPanel
    ? `blur(${appearance.panelBlurPx}px)`
    : 'none';
}

let lastIso = '';

function renderNow() {
  const now = new Date();
  lastIso = now.toISOString();
  const timeText = now.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const dateText = now.toLocaleDateString([], {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });

  timeEl.textContent = timeText;
  dateEl.textContent = dateText;
}

applyAppearance();
renderNow();
setInterval(renderNow, 1000);

const appApi = (window as any).yaar?.app;
if (appApi) {
  appApi.register({
    appId: 'dock',
    name: 'Dock',
    state: {
      nowIso: {
        description: 'Current time in ISO format',
        handler: () => lastIso,
      },
      display: {
        description: 'Current displayed date/time text',
        handler: () => ({
          time: timeEl.textContent || '',
          date: dateEl.textContent || '',
        }),
      },
      appearance: {
        description: 'Current dock appearance settings',
        handler: () => ({ ...appearance }),
      },
    },
    commands: {
      refreshNow: {
        description: 'Force immediate clock refresh. Params: {}',
        params: { type: 'object', properties: {} },
        handler: () => {
          renderNow();
          return { ok: true, nowIso: lastIso };
        },
      },
      setAppearance: {
        description:
          'Update dock appearance. Params: { showPanel?: boolean, panelOpacity?: number (0-1), panelBlurPx?: number (0-40) }',
        params: {
          type: 'object',
          properties: {
            showPanel: { type: 'boolean' },
            panelOpacity: { type: 'number', minimum: 0, maximum: 1 },
            panelBlurPx: { type: 'number', minimum: 0, maximum: 40 },
          },
        },
        handler: (params: {
          showPanel?: boolean;
          panelOpacity?: number;
          panelBlurPx?: number;
        }) => {
          if (typeof params?.showPanel === 'boolean') {
            appearance.showPanel = params.showPanel;
          }
          if (typeof params?.panelOpacity === 'number') {
            appearance.panelOpacity = Math.max(0, Math.min(1, params.panelOpacity));
          }
          if (typeof params?.panelBlurPx === 'number') {
            appearance.panelBlurPx = Math.max(0, Math.min(40, params.panelBlurPx));
          }
          applyAppearance();
          return { ok: true, appearance: { ...appearance } };
        },
      },
    },
  });
}
