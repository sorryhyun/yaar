export {};
import { createSignal, onMount, onCleanup } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { render } from '@bundled/solid-js/web';
import './styles.css';

// ─── Signals ─────────────────────────────────────────────────────────────────
const [isYouTubeMode, setIsYouTubeMode] = createSignal(false);
const [statusText, setStatusText] = createSignal('No source loaded.');
const [statusKind, setStatusKind] = createSignal<'ok' | 'err' | 'info'>('info');
const [timeMeta, setTimeMeta] = createSignal('00:00 / 00:00');
const [isPlaying, setIsPlaying] = createSignal(false);
const [isMuted, setIsMuted] = createSignal(false);
const [controlsDisabled, setControlsDisabled] = createSignal(true);

// ─── DOM refs ─────────────────────────────────────────────────────────────────
let playerEl!: HTMLVideoElement;
let ytPlayerEl!: HTMLIFrameElement;
let urlInputEl!: HTMLInputElement;
let fileInputEl!: HTMLInputElement;
let speedSelectEl!: HTMLSelectElement;

// ─── Private state ────────────────────────────────────────────────────────────
let lastObjectUrl: string | null = null;
let sourceLabel = 'No source loaded';

// ─── Utilities ────────────────────────────────────────────────────────────────
const formatTime = (value: number): string => {
  if (!Number.isFinite(value) || value < 0) return '00:00';
  const total = Math.floor(value);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const setStatus = (text: string, kind: 'ok' | 'err' | 'info' = 'info'): void => {
  setStatusText(text);
  setStatusKind(kind);
};

const updateTimeMeta = (): void => {
  if (isYouTubeMode()) {
    setTimeMeta('YouTube embed');
    return;
  }
  const current = formatTime(playerEl.currentTime || 0);
  const duration = formatTime(playerEl.duration || 0);
  setTimeMeta(`${current} / ${duration}`);
};

const cleanupObjectUrl = (): void => {
  if (lastObjectUrl) {
    URL.revokeObjectURL(lastObjectUrl);
    lastObjectUrl = null;
  }
};

// ─── Source loading ────────────────────────────────────────────────────────────
const loadVideoSource = (src: string, label: string): void => {
  setIsYouTubeMode(false);
  ytPlayerEl.src = '';
  setControlsDisabled(false);
  playerEl.src = src;
  sourceLabel = label;
  playerEl.load();
  setStatus(`Loading: ${label}`, 'info');
  updateTimeMeta();
};

const loadYouTubeSource = (embedUrl: string, label: string): void => {
  setIsYouTubeMode(true);
  playerEl.pause();
  playerEl.removeAttribute('src');
  playerEl.load();
  ytPlayerEl.src = embedUrl;
  sourceLabel = label;
  setControlsDisabled(true);
  setIsPlaying(false);
  setIsMuted(false);
  updateTimeMeta();
  setStatus(`Loaded: ${label} (YouTube embed)`, 'ok');
};

// ─── YouTube URL parsing ───────────────────────────────────────────────────────
const parseYouTubeStartSeconds = (raw: string | null): string | null => {
  if (!raw) return null;
  const value = raw.trim();
  if (/^\d+$/.test(value)) return value;
  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!match) return null;
  const hours = Number(match[1] ?? '0');
  const minutes = Number(match[2] ?? '0');
  const seconds = Number(match[3] ?? '0');
  const total = hours * 3600 + minutes * 60 + seconds;
  return total > 0 ? String(total) : null;
};

const getYouTubeEmbedUrl = (parsed: URL): string | null => {
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  let videoId = '';
  if (host === 'youtu.be') {
    videoId = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
  } else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    const path = parsed.pathname.split('/').filter(Boolean);
    const first = path[0] ?? '';
    if (first === 'watch') {
      videoId = parsed.searchParams.get('v') ?? '';
    } else if (first === 'shorts' || first === 'embed') {
      videoId = path[1] ?? '';
    }
  } else {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
  const embed = new URL(`https://www.youtube.com/embed/${videoId}`);
  const start = parseYouTubeStartSeconds(parsed.searchParams.get('start') ?? parsed.searchParams.get('t'));
  if (start) embed.searchParams.set('start', start);
  return embed.toString();
};

type ParsedRemoteUrl = { sourceUrl: string; isYouTube: boolean };

const parseRemoteUrl = (raw: string): ParsedRemoteUrl | null => {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const ytEmbed = getYouTubeEmbedUrl(parsed);
    if (ytEmbed) return { sourceUrl: ytEmbed, isYouTube: true };
    return { sourceUrl: parsed.toString(), isYouTube: false };
  } catch {
    return null;
  }
};

// ─── Event handlers ────────────────────────────────────────────────────────────
const handleLoadUrl = (): void => {
  const parsed = parseRemoteUrl(urlInputEl.value);
  if (!parsed) {
    setStatus('Invalid URL. Use a full http(s) video URL.', 'err');
    return;
  }
  cleanupObjectUrl();
  if (parsed.isYouTube) {
    loadYouTubeSource(parsed.sourceUrl, parsed.sourceUrl);
    return;
  }
  loadVideoSource(parsed.sourceUrl, parsed.sourceUrl);
};

const handleFileChange = (): void => {
  const file = fileInputEl.files?.[0];
  if (!file) { setStatus('No file selected.', 'err'); return; }
  if (!file.type.startsWith('video/')) {
    setStatus('Selected file is not a video.', 'err');
    fileInputEl.value = '';
    return;
  }
  cleanupObjectUrl();
  lastObjectUrl = URL.createObjectURL(file);
  loadVideoSource(lastObjectUrl, file.name);
};

const handlePlayPause = async (): Promise<void> => {
  if (isYouTubeMode()) return;
  try {
    if (playerEl.paused) { await playerEl.play(); }
    else { playerEl.pause(); }
  } catch {
    setStatus('Playback failed. The source may be blocked or unsupported.', 'err');
  }
};

const handleBack = (): void => {
  if (isYouTubeMode()) return;
  playerEl.currentTime = Math.max(0, playerEl.currentTime - 10);
  updateTimeMeta();
};

const handleFwd = (): void => {
  if (isYouTubeMode()) return;
  const max = Number.isFinite(playerEl.duration) && playerEl.duration > 0
    ? playerEl.duration : playerEl.currentTime + 10;
  playerEl.currentTime = Math.min(max, playerEl.currentTime + 10);
  updateTimeMeta();
};

const handleSpeedChange = (): void => {
  if (isYouTubeMode()) return;
  const speed = Number(speedSelectEl.value);
  playerEl.playbackRate = Number.isFinite(speed) ? speed : 1;
  setStatus(`Speed set to ${playerEl.playbackRate}x`, 'ok');
};

const handleMute = (): void => {
  if (isYouTubeMode()) return;
  playerEl.muted = !playerEl.muted;
  setIsMuted(playerEl.muted);
};

// ─── Lifecycle ────────────────────────────────────────────────────────────────
onMount(() => {
  playerEl.addEventListener('loadedmetadata', () => {
    updateTimeMeta();
    setIsPlaying(!playerEl.paused);
    setIsMuted(playerEl.muted);
    setStatus(`Loaded: ${sourceLabel}`, 'ok');
  });
  playerEl.addEventListener('timeupdate', updateTimeMeta);
  playerEl.addEventListener('play', () => { setIsPlaying(true); });
  playerEl.addEventListener('pause', () => { setIsPlaying(false); });
  playerEl.addEventListener('volumechange', () => { setIsMuted(playerEl.muted); });
  playerEl.addEventListener('error', () => {
    setStatus('Could not load this video source. Check URL, CORS, or file format.', 'err');
  });

  updateTimeMeta();

  onCleanup(cleanupObjectUrl);
});

// ─── Template ─────────────────────────────────────────────────────────────────
render(() => html`
  <div class="app">
    <section class="shell">
      <div class="title">
        <h1>Video Viewer Lite</h1>
        <div class="meta">${() => timeMeta()}</div>
      </div>

      <div class="input-row">
        <input
          ref=${(el: HTMLInputElement) => { urlInputEl = el; }}
          class="y-input" type="url"
          placeholder="Paste remote video URL (https://...)"
          aria-label="Remote video URL"
          onKeydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') handleLoadUrl(); }}
        />
        <button class="y-btn y-btn-primary" type="button" onClick=${handleLoadUrl}>Load URL</button>
      </div>

      <div class="file-row">
        <input
          ref=${(el: HTMLInputElement) => { fileInputEl = el; }}
          type="file" accept="video/*"
          onChange=${handleFileChange}
        />
        <span class="y-text-muted">Select a local video file to play</span>
      </div>

      <div class="controls">
        <button class="y-btn" type="button"
          disabled=${() => controlsDisabled()}
          onClick=${handlePlayPause}>
          ${() => isPlaying() ? 'Pause' : 'Play'}
        </button>
        <button class="y-btn" type="button"
          disabled=${() => controlsDisabled()}
          onClick=${handleBack}>-10s</button>
        <button class="y-btn" type="button"
          disabled=${() => controlsDisabled()}
          onClick=${handleFwd}>+10s</button>
        <select
          ref=${(el: HTMLSelectElement) => { speedSelectEl = el; }}
          class="y-input" aria-label="Playback speed"
          disabled=${() => controlsDisabled()}
          onChange=${handleSpeedChange}>
          <option value="0.5">0.5x</option>
          <option value="1" selected>1x</option>
          <option value="1.5">1.5x</option>
          <option value="2">2x</option>
        </select>
        <button class="y-btn" type="button"
          disabled=${() => controlsDisabled()}
          onClick=${handleMute}>
          ${() => isMuted() ? 'Unmute' : 'Mute'}
        </button>
      </div>

      <div class="video-wrap y-rounded-lg">
        <video
          ref=${(el: HTMLVideoElement) => { playerEl = el; }}
          controls playsinline preload="metadata"
          class=${() => isYouTubeMode() ? 'is-hidden' : ''}
        ></video>
        <iframe
          ref=${(el: HTMLIFrameElement) => { ytPlayerEl = el; }}
          class=${() => isYouTubeMode() ? '' : 'is-hidden'}
          title="YouTube player"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerpolicy="strict-origin-when-cross-origin"
          allowfullscreen
        ></iframe>
      </div>

      <div class=${() => {
        const k = statusKind();
        return 'status' + (k === 'ok' ? ' ok' : '') + (k === 'err' ? ' err' : '');
      }}>
        ${() => statusText()}
      </div>
    </section>
  </div>
`, document.getElementById('app')!);
