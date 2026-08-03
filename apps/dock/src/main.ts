import { createSignal, onMount, onCleanup, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { defineApp, notifications, safeParseOr } from '@bundled/yaar';
import { OpenMeteoResponse, NominatimResponse } from './schema';
import './styles.css';

// ── WMO code → emoji ─────────────────────────────────────────────────────────
function wmoEmoji(code: number): string {
  if (code === 0) return '☀️';
  if (code === 1) return '🌤️';
  if (code === 2) return '⛅';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if ([51, 53, 55, 56, 57].includes(code)) return '🌦️';
  if (code === 61 || code === 63 || code === 65) return '🌧️';
  if ([71, 73, 75, 77].includes(code)) return '🌨️';
  if ([80, 81, 82].includes(code)) return '🌦️';
  if (code === 85 || code === 86) return '🌨️';
  if (code === 95) return '⛈️';
  if (code === 96 || code === 99) return '⛈️';
  return '🌡️';
}

// ── Signals ───────────────────────────────────────────────────────────────────
const [timeStr, setTimeStr] = createSignal('');
const [dateStr, setDateStr] = createSignal('');
const [nowIso, setNowIso] = createSignal('');

const [weatherIcon, setWeatherIcon] = createSignal('🌡️');
const [weatherTemp, setWeatherTemp] = createSignal('--°');
const [weatherCity, setWeatherCity] = createSignal('');

const [notifCount, setNotifCount] = createSignal(0);

const [showPanel, setShowPanel] = createSignal(false);
const [panelOpacity, setPanelOpacity] = createSignal(0.45);
const [panelBlurPx, setPanelBlurPx] = createSignal(10);

// ── Panel style (reactive) ────────────────────────────────────────────────────
function panelStyle(): string {
  if (!showPanel()) {
    return [
      'background:transparent',
      'border:1px solid transparent',
      'box-shadow:none',
      'backdrop-filter:none',
      '-webkit-backdrop-filter:none',
    ].join(';');
  }
  const opacity = panelOpacity();
  const blur = panelBlurPx();
  return [
    `background:rgba(10,12,16,${opacity})`,
    'border-bottom:1px solid rgba(255,255,255,0.10)',
    'box-shadow:0 4px 24px rgba(0,0,0,0.4)',
    `backdrop-filter:blur(${blur}px)`,
    `-webkit-backdrop-filter:blur(${blur}px)`,
  ].join(';');
}

// ── Clock ─────────────────────────────────────────────────────────────────────
function renderNow() {
  const now = new Date();
  setNowIso(now.toISOString());
  setTimeStr(now.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }));
  setDateStr(now.toLocaleDateString([], {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  }));
}

// ── Weather ───────────────────────────────────────────────────────────────────
const SEOUL_LAT = 37.5665;
const SEOUL_LON = 126.978;

async function fetchWeather(lat: number, lon: number, city: string) {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weather_code&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('weather fetch failed');
    // Graceful degradation: dock is core chrome, keep previous weather state.
    const data = safeParseOr(OpenMeteoResponse, await res.json(), undefined, {
      label: 'dock:weather',
    });
    if (!data) return;
    const current = data.current;
    if (current?.temperature_2m === undefined || current.weather_code === undefined) {
      console.error('open-meteo response missing current weather fields');
      return;
    }
    const temp = Math.round(current.temperature_2m);
    const code = current.weather_code;
    setWeatherIcon(wmoEmoji(code));
    setWeatherTemp(`${temp}°C`);
    setWeatherCity(city);
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
    // Graceful degradation: fall back to 'Unknown' rather than throwing.
    const data = safeParseOr(NominatimResponse, await res.json(), undefined, {
      label: 'dock:geocode',
    });
    if (!data) return 'Unknown';
    const address = data.address;
    return address?.city || address?.town || address?.county || 'Unknown';
  } catch (_) {
    return 'Unknown';
  }
}

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

// ── App Component ─────────────────────────────────────────────────────────────
function App() {
  onMount(() => {
    // Clock — tick every second
    renderNow();
    const clockTimer = setInterval(renderNow, 1000);
    onCleanup(() => clearInterval(clockTimer));

    // Weather — initial fetch + refresh every 15 min
    initWeather();
    const weatherTimer = setInterval(initWeather, 15 * 60 * 1000);
    onCleanup(() => clearInterval(weatherTimer));

    // Notifications subscription
    if (notifications) {
      notifications.onChange((items: unknown[]) => {
        setNotifCount(items.length);
      });
    }
  });

  return html`
    <div class="panel" style=${() => panelStyle()}>

      <!-- Row 1: Time (big) -->
      <div class="row row-time">
        <span class="time">${() => timeStr()}</span>
      </div>

      <!-- Row 2: Date -->
      <div class="row row-date">
        <span class="date">${() => dateStr()}</span>
      </div>

      <!-- Row 3: Weather + Notifications -->
      <div class="row row-bottom">
        <div class="weather-section">
          <span class="weather-icon">${() => weatherIcon()}</span>
          <span class="weather-temp">${() => weatherTemp()}</span>
          <${Show} when=${() => weatherCity() !== ''}>
            <span class="weather-city">${() => weatherCity()}</span>
          </${Show}>
        </div>

        <span class="sep">·</span>

        <div class="notif-section">
          <span class=${() => 'notif-icon' + (notifCount() > 0 ? '' : ' notif-muted')}>🔔</span>
          <${Show} when=${() => notifCount() > 0}>
            <span class="notif-count">${() => String(notifCount())}</span>
          </${Show}>
        </div>
      </div>

    </div>
  `;
}

// ── App Protocol + Mount ─────────────────────────────────────────────────────
export default defineApp({
  id: 'dock',
  name: 'Dock',
  state: {
    nowIso: {
      description: 'Current time in ISO format',
      get: () => nowIso(),
    },
    display: {
      description: 'Current displayed date/time text: { time, date }',
      get: () => ({
        time: timeStr(),
        date: dateStr(),
      }),
    },
    appearance: {
      description: 'Current dock appearance settings: { showPanel, panelOpacity, panelBlurPx }',
      get: () => ({
        showPanel: showPanel(),
        panelOpacity: panelOpacity(),
        panelBlurPx: panelBlurPx(),
      }),
    },
    weather: {
      description: 'Current weather data: { icon, temp, city }',
      get: () => ({
        icon: weatherIcon(),
        temp: weatherTemp(),
        city: weatherCity(),
      }),
    },
  },
  commands: {
    refreshNow: {
      description: 'Force immediate clock refresh. Params: {}',
      params: { type: 'object', properties: {} },
      run: () => {
        renderNow();
        return { nowIso: nowIso() };
      },
    },
    refreshWeather: {
      description: 'Force re-fetch weather data. Params: {}',
      params: { type: 'object', properties: {} },
      run: async () => {
        await initWeather();
        return {
          weather: {
            icon: weatherIcon(),
            temp: weatherTemp(),
            city: weatherCity(),
          },
        };
      },
    },
    setAppearance: {
      description:
        'Update dock appearance. Params: { showPanel?: boolean, panelOpacity?: number (0–1), panelBlurPx?: number (0–40) }',
      params: {
        type: 'object',
        properties: {
          showPanel: { type: 'boolean' },
          panelOpacity: { type: 'number', minimum: 0, maximum: 1 },
          panelBlurPx: { type: 'number', minimum: 0, maximum: 40 },
        },
      },
      run: (p) => {
        if (typeof p?.showPanel === 'boolean') setShowPanel(p.showPanel);
        if (typeof p?.panelOpacity === 'number')
          setPanelOpacity(Math.max(0, Math.min(1, p.panelOpacity)));
        if (typeof p?.panelBlurPx === 'number')
          setPanelBlurPx(Math.max(0, Math.min(40, p.panelBlurPx)));
        // Signals are reactive — DOM updates automatically, no applyAppearance() needed
        return {
          appearance: {
            showPanel: showPanel(),
            panelOpacity: panelOpacity(),
            panelBlurPx: panelBlurPx(),
          },
        };
      },
    },
  },
  view: App,
});
