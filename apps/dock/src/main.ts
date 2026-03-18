import { createSignal, onMount, onCleanup, Show } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import { notifications } from '@bundled/yaar';
import { registerDockProtocol } from './protocol';
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
    const data = await res.json();
    const temp = Math.round(data.current.temperature_2m);
    const code = data.current.weather_code as number;
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

// ── Mount ─────────────────────────────────────────────────────────────────────
render(() => html`<${App} />`, document.getElementById('app')!);

// ── App Protocol ──────────────────────────────────────────────────────────────
registerDockProtocol({
  getNowIso:       () => nowIso(),
  getTimeStr:      () => timeStr(),
  getDateStr:      () => dateStr(),
  getWeatherIcon:  () => weatherIcon(),
  getWeatherTemp:  () => weatherTemp(),
  getWeatherCity:  () => weatherCity(),
  getShowPanel:    () => showPanel(),
  getPanelOpacity: () => panelOpacity(),
  getPanelBlurPx:  () => panelBlurPx(),
  setShowPanel:    (v) => setShowPanel(v),
  setPanelOpacity: (v) => setPanelOpacity(v),
  setPanelBlurPx:  (v) => setPanelBlurPx(v),
  renderNow,
  initWeather,
});
