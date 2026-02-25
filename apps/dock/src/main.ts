// ─────────────────────────────────────────────────────────────
// Dock — clock + weather + notifications
// ─────────────────────────────────────────────────────────────

// ── DOM bootstrap ──────────────────────────────────────────────
const root = document.createElement('div');
root.id = 'dock-root';
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
    margin: 0;
    color: #eef1f6;
  }
  #dock-root {
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
    align-items: center;
    justify-content: flex-end;
    padding: 2px 12px;
    border-radius: 10px;
    background: rgba(10, 12, 16, 0.45);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 6px 30px rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    gap: 0;
  }
  /* sections */
  .weather-section,
  .notif-section,
  .clock-section {
    display: flex;
    align-items: center;
  }
  .weather-section { gap: 4px; }
  .notif-section   { gap: 4px; }
  .clock-section   { align-items: baseline; gap: 8px; }

  .sep {
    color: rgba(255,255,255,0.25);
    font-size: 18px;
    margin: 0 6px;
    line-height: 1;
  }

  /* weather */
  .weather-icon { font-size: 16px; line-height: 1; }
  .weather-temp {
    font-size: 14px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .weather-city {
    font-size: 13px;
    color: #a8b5c4;
  }

  /* notifications */
  .notif-icon { font-size: 15px; line-height: 1; }
  .notif-count {
    font-size: 13px;
    font-weight: 700;
    color: #7ec8fa;
    font-variant-numeric: tabular-nums;
  }
  .notif-muted { color: rgba(255,255,255,0.35); }

  /* clock */
  .time {
    font-size: 24px;
    font-weight: 700;
    letter-spacing: 0.1px;
    line-height: 1;
    text-shadow: 0 1px 4px rgba(0,0,0,0.6);
    font-variant-numeric: tabular-nums;
  }
  .date {
    font-size: 16px;
    font-weight: 600;
    color: #d4dbe6;
    line-height: 1;
    text-shadow: 0 1px 3px rgba(0,0,0,0.5);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
`;
document.head.appendChild(style);

// ── Panel structure ─────────────────────────────────────────────
const panelEl = document.createElement('div');
panelEl.className = 'panel';

// Weather section
const weatherSection = document.createElement('div');
weatherSection.className = 'weather-section';
const weatherIconEl = document.createElement('span');
weatherIconEl.className = 'weather-icon';
weatherIconEl.textContent = '🌡️';
const weatherTempEl = document.createElement('span');
weatherTempEl.className = 'weather-temp';
weatherTempEl.textContent = '--°';
const weatherCityEl = document.createElement('span');
weatherCityEl.className = 'weather-city';
weatherCityEl.textContent = '';
weatherSection.appendChild(weatherIconEl);
weatherSection.appendChild(weatherTempEl);
weatherSection.appendChild(weatherCityEl);

const sep1 = document.createElement('span');
sep1.className = 'sep';
sep1.textContent = '|';

// Notification section
const notifSection = document.createElement('div');
notifSection.className = 'notif-section';
const notifIconEl = document.createElement('span');
notifIconEl.className = 'notif-icon notif-muted';
notifIconEl.textContent = '🔔';
const notifCountEl = document.createElement('span');
notifCountEl.className = 'notif-count';
notifCountEl.textContent = '';
notifSection.appendChild(notifIconEl);
notifSection.appendChild(notifCountEl);

const sep2 = document.createElement('span');
sep2.className = 'sep';
sep2.textContent = '|';

// Clock section
const clockSection = document.createElement('div');
clockSection.className = 'clock-section';
const timeEl = document.createElement('div');
timeEl.className = 'time';
const dateEl = document.createElement('div');
dateEl.className = 'date';
clockSection.appendChild(timeEl);
clockSection.appendChild(dateEl);

panelEl.appendChild(weatherSection);
panelEl.appendChild(sep1);
panelEl.appendChild(notifSection);
panelEl.appendChild(sep2);
panelEl.appendChild(clockSection);
root.appendChild(panelEl);

// ── Appearance ──────────────────────────────────────────────────
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

// ── Clock ───────────────────────────────────────────────────────
let lastIso = '';

function renderNow() {
  const now = new Date();
  lastIso = now.toISOString();
  timeEl.textContent = now.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  dateEl.textContent = now.toLocaleDateString([], {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

// ── WMO code → emoji ────────────────────────────────────────────
function wmoEmoji(code: number): string {
  if (code === 0) return '☀️';
  if (code === 1) return '🌤️';
  if (code === 2) return '⛅';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if ([51,53,55,56,57].includes(code)) return '🌦️';
  if (code === 61 || code === 63 || code === 65) return '🌧️';
  if ([71,73,75,77].includes(code)) return '🌨️';
  if ([80,81,82].includes(code)) return '🌦️';
  if (code === 85 || code === 86) return '🌨️';
  if (code === 95) return '⛈️';
  if (code === 96 || code === 99) return '⛈️';
  return '🌡️';
}

// ── Weather state ───────────────────────────────────────────────
interface WeatherState {
  icon: string;
  temp: string;
  city: string;
  updatedAt: string;
}

let weatherState: WeatherState = { icon: '🌡️', temp: '--°', city: '', updatedAt: '' };

function renderWeather() {
  weatherIconEl.textContent = weatherState.icon;
  weatherTempEl.textContent = weatherState.temp;
  weatherCityEl.textContent = weatherState.city;
}

async function fetchWeather(lat: number, lon: number, city: string) {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weather_code&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('weather fetch failed');
    const data = await res.json();
    const temp = Math.round(data.current.temperature_2m);
    const code = data.current.weather_code as number;
    weatherState = {
      icon: wmoEmoji(code),
      temp: `${temp}°C`,
      city,
      updatedAt: new Date().toISOString(),
    };
    renderWeather();
  } catch (_) {
    // silently keep previous state
  }
}

async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
      { headers: { 'Accept-Language': 'en' } }
    );
    if (!res.ok) throw new Error('geo failed');
    const data = await res.json();
    return (
      data?.address?.city ||
      data?.address?.town ||
      data?.address?.county ||
      'Unknown'
    );
  } catch (_) {
    return 'Unknown';
  }
}

const SEOUL_LAT = 37.5665;
const SEOUL_LON = 126.978;

async function initWeather() {
  if (!('geolocation' in navigator)) {
    await fetchWeather(SEOUL_LAT, SEOUL_LON, 'Seoul');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      const city = await reverseGeocode(latitude, longitude);
      await fetchWeather(latitude, longitude, city);
    },
    async (_err) => {
      await fetchWeather(SEOUL_LAT, SEOUL_LON, 'Seoul');
    },
    { timeout: 5000 }
  );
}

// ── Notifications ───────────────────────────────────────────────
let notifCount = 0;

function renderNotif() {
  if (notifCount > 0) {
    notifIconEl.className = 'notif-icon';
    notifCountEl.textContent = String(notifCount);
  } else {
    notifIconEl.className = 'notif-icon notif-muted';
    notifCountEl.textContent = '';
  }
}

// Subscribe to notification state pushed from parent via SDK
const notifApi = (window as any).yaar?.notifications;
if (notifApi) {
  notifApi.onChange((items: unknown[]) => {
    notifCount = items.length;
    renderNotif();
  });
}

// ── Init & intervals ────────────────────────────────────────────
applyAppearance();
renderNow();
setInterval(renderNow, 1000);

initWeather();
setInterval(initWeather, 15 * 60 * 1000); // every 15 min

// ── App Protocol ────────────────────────────────────────────────
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
      weather: {
        description: 'Current weather data: { icon, temp, city, updatedAt }',
        handler: () => ({ ...weatherState }),
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
      refreshWeather: {
        description: 'Force re-fetch weather data. Params: {}',
        params: { type: 'object', properties: {} },
        handler: async () => {
          await initWeather();
          return { ok: true, weather: { ...weatherState } };
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
