export {};

const app = document.createElement('div');
app.className = 'app';

app.innerHTML = `
  <style>
    :root {
      --yaar-bg: #f7fbff;
      --yaar-bg-surface: #ffffffcc;
      --yaar-bg-surface-hover: #eef4ff;
      --yaar-text: #1d2a3a;
      --yaar-text-muted: #5f6f85;
      --yaar-text-dim: #8b949e;
      --yaar-border: #d8e3f0;
      --yaar-accent: #1769e0;
      --yaar-accent-hover: #0f57c2;
      --yaar-shadow: 0 10px 30px rgba(23, 105, 224, 0.12);
      --yaar-shadow-sm: 0 1px 2px rgba(0,0,0,.08);
    }

    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      color: var(--yaar-text);
      background: radial-gradient(1200px 500px at 20% -20%, #dcebff 0%, transparent 70%),
                  radial-gradient(900px 500px at 110% 120%, #d8e8ff 0%, transparent 60%),
                  linear-gradient(145deg, #f7fbff, #eef4ff);
    }

    .app {
      min-height: 100%;
      padding: 16px;
      display: grid;
      place-items: center;
    }

    .shell {
      width: min(980px, 100%);
      display: grid;
      gap: 12px;
      padding: 14px;
      border: 1px solid var(--yaar-border);
      border-radius: 18px;
      background: var(--yaar-bg-surface);
      backdrop-filter: blur(6px);
      box-shadow: var(--yaar-shadow);
    }

    .title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }

    .title h1 {
      margin: 0;
      font-size: 1.1rem;
      font-weight: 700;
      letter-spacing: 0.2px;
    }

    .status {
      font-size: 0.9rem;
      color: var(--yaar-text-muted);
      min-height: 1.2em;
      word-break: break-word;
    }

    .status.ok {
      color: #0a7f43;
    }

    .status.err {
      color: #b42318;
    }

    .input-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
    }

    .file-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .controls {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, auto));
      gap: 8px;
      align-items: center;
      justify-content: start;
      flex-wrap: wrap;
    }

    .video-wrap {
      width: 100%;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid var(--yaar-border);
      background: #0b1220;
    }

    video {
      display: block;
      width: 100%;
      max-height: min(62vh, 560px);
      background: #000;
    }

    iframe {
      display: block;
      width: 100%;
      aspect-ratio: 16 / 9;
      border: 0;
      background: #000;
    }

    .is-hidden {
      display: none;
    }

    @media (max-width: 720px) {
      .input-row {
        grid-template-columns: 1fr;
      }

      .controls {
        grid-template-columns: repeat(3, minmax(0, auto));
      }
    }
  </style>

  <section class="shell">
    <div class="title">
      <h1>Video Viewer Lite</h1>
      <div class="meta" id="timeMeta">00:00 / 00:00</div>
    </div>

    <div class="input-row">
      <input id="urlInput" class="y-input" type="url" placeholder="Paste remote video URL (https://...)" aria-label="Remote video URL" />
      <button id="loadUrlBtn" class="y-btn y-btn-primary" type="button">Load URL</button>
    </div>

    <div class="file-row">
      <input id="fileInput" type="file" accept="video/*" />
      <span class="y-text-muted">Select a local video file to play</span>
    </div>

    <div class="controls">
      <button id="playPauseBtn" class="y-btn" type="button">Play</button>
      <button id="backBtn" class="y-btn" type="button">-10s</button>
      <button id="fwdBtn" class="y-btn" type="button">+10s</button>
      <select id="speedSelect" class="y-input" aria-label="Playback speed">
        <option value="0.5">0.5x</option>
        <option value="1" selected>1x</option>
        <option value="1.5">1.5x</option>
        <option value="2">2x</option>
      </select>
      <button id="muteBtn" class="y-btn" type="button">Mute</button>
    </div>

    <div class="video-wrap y-rounded-lg">
      <video id="player" controls playsinline preload="metadata"></video>
      <iframe
        id="ytPlayer"
        class="is-hidden"
        title="YouTube player"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        referrerpolicy="strict-origin-when-cross-origin"
        allowfullscreen
      ></iframe>
    </div>

    <div id="status" class="status y-text-muted">No source loaded.</div>
  </section>
`;

document.body.innerHTML = '';
document.body.appendChild(app);

const player = document.getElementById('player') as HTMLVideoElement;
const ytPlayer = document.getElementById('ytPlayer') as HTMLIFrameElement;
const urlInput = document.getElementById('urlInput') as HTMLInputElement;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const loadUrlBtn = document.getElementById('loadUrlBtn') as HTMLButtonElement;
const playPauseBtn = document.getElementById('playPauseBtn') as HTMLButtonElement;
const backBtn = document.getElementById('backBtn') as HTMLButtonElement;
const fwdBtn = document.getElementById('fwdBtn') as HTMLButtonElement;
const speedSelect = document.getElementById('speedSelect') as HTMLSelectElement;
const muteBtn = document.getElementById('muteBtn') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const timeMeta = document.getElementById('timeMeta') as HTMLDivElement;

let lastObjectUrl: string | null = null;
let sourceLabel = 'No source loaded';
let isYouTubeMode = false;

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
  statusEl.textContent = text;
  statusEl.classList.remove('ok', 'err');
  if (kind === 'ok') statusEl.classList.add('ok');
  if (kind === 'err') statusEl.classList.add('err');
};

const updateTimeMeta = (): void => {
  if (isYouTubeMode) {
    timeMeta.textContent = 'YouTube embed';
    return;
  }
  const current = formatTime(player.currentTime || 0);
  const duration = formatTime(player.duration || 0);
  timeMeta.textContent = `${current} / ${duration}`;
};

const updateButtons = (): void => {
  playPauseBtn.textContent = player.paused ? 'Play' : 'Pause';
  muteBtn.textContent = player.muted ? 'Unmute' : 'Mute';
};

const cleanupObjectUrl = (): void => {
  if (lastObjectUrl) {
    URL.revokeObjectURL(lastObjectUrl);
    lastObjectUrl = null;
  }
};

const setControlsEnabled = (enabled: boolean): void => {
  playPauseBtn.disabled = !enabled;
  backBtn.disabled = !enabled;
  fwdBtn.disabled = !enabled;
  speedSelect.disabled = !enabled;
  muteBtn.disabled = !enabled;
};

const loadVideoSource = (src: string, label: string): void => {
  isYouTubeMode = false;
  ytPlayer.classList.add('is-hidden');
  ytPlayer.src = '';
  player.classList.remove('is-hidden');
  setControlsEnabled(true);
  player.src = src;
  sourceLabel = label;
  player.load();
  setStatus(`Loading: ${label}`, 'info');
  updateTimeMeta();
};

const loadYouTubeSource = (embedUrl: string, label: string): void => {
  isYouTubeMode = true;
  player.pause();
  player.removeAttribute('src');
  player.load();
  player.classList.add('is-hidden');
  ytPlayer.classList.remove('is-hidden');
  ytPlayer.src = embedUrl;
  sourceLabel = label;
  setControlsEnabled(false);
  updateButtons();
  updateTimeMeta();
  setStatus(`Loaded: ${label} (YouTube embed)`, 'ok');
};

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
  if (start) {
    embed.searchParams.set('start', start);
  }
  return embed.toString();
};

type ParsedRemoteUrl = {
  sourceUrl: string;
  isYouTube: boolean;
};

const parseRemoteUrl = (raw: string): ParsedRemoteUrl | null => {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const ytEmbed = getYouTubeEmbedUrl(parsed);
    if (ytEmbed) {
      return { sourceUrl: ytEmbed, isYouTube: true };
    }
    return { sourceUrl: parsed.toString(), isYouTube: false };
  } catch {
    return null;
  }
};

loadUrlBtn.addEventListener('click', () => {
  const parsed = parseRemoteUrl(urlInput.value);
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
});

urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    loadUrlBtn.click();
  }
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) {
    setStatus('No file selected.', 'err');
    return;
  }
  if (!file.type.startsWith('video/')) {
    setStatus('Selected file is not a video.', 'err');
    fileInput.value = '';
    return;
  }

  cleanupObjectUrl();
  lastObjectUrl = URL.createObjectURL(file);
  loadVideoSource(lastObjectUrl, file.name);
});

playPauseBtn.addEventListener('click', async () => {
  if (isYouTubeMode) return;
  try {
    if (player.paused) {
      await player.play();
    } else {
      player.pause();
    }
  } catch {
    setStatus('Playback failed. The source may be blocked or unsupported.', 'err');
  }
  updateButtons();
});

backBtn.addEventListener('click', () => {
  if (isYouTubeMode) return;
  player.currentTime = Math.max(0, player.currentTime - 10);
  updateTimeMeta();
});

fwdBtn.addEventListener('click', () => {
  if (isYouTubeMode) return;
  const max = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : player.currentTime + 10;
  player.currentTime = Math.min(max, player.currentTime + 10);
  updateTimeMeta();
});

speedSelect.addEventListener('change', () => {
  if (isYouTubeMode) return;
  const speed = Number(speedSelect.value);
  player.playbackRate = Number.isFinite(speed) ? speed : 1;
  setStatus(`Speed set to ${player.playbackRate}x`, 'ok');
});

muteBtn.addEventListener('click', () => {
  if (isYouTubeMode) return;
  player.muted = !player.muted;
  updateButtons();
});

player.addEventListener('loadedmetadata', () => {
  updateTimeMeta();
  updateButtons();
  setStatus(`Loaded: ${sourceLabel}`, 'ok');
});

player.addEventListener('timeupdate', updateTimeMeta);
player.addEventListener('play', updateButtons);
player.addEventListener('pause', updateButtons);
player.addEventListener('volumechange', updateButtons);

player.addEventListener('error', () => {
  setStatus('Could not load this video source. Check URL, CORS, or file format.', 'err');
});

window.addEventListener('beforeunload', cleanupObjectUrl);

updateTimeMeta();
updateButtons();
