const root = document.createElement('div');
root.id = 'dock-clock-root';
document.body.appendChild(root);

const style = document.createElement('style');
style.textContent = `
  :root {
    color-scheme: dark;
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
    align-items: center;
    justify-content: center;
    user-select: none;
    padding: 12px;
    box-sizing: border-box;
  }
  .panel {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 12px 16px;
    border-radius: 14px;
    background: rgba(10, 12, 16, 0.45);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 6px 30px rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .time {
    font-size: 38px;
    font-weight: 700;
    letter-spacing: 0.5px;
    line-height: 1;
  }
  .date {
    font-size: 14px;
    color: #c2cad6;
    line-height: 1.2;
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
    },
  });
}
