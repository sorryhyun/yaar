/**
 * The screencast socket: open it, route what comes back, close it — and pause it
 * while nobody can see the window.
 *
 * Binary frames are pixels (paint.ts); text frames are the small control
 * protocol below, which is the only thing that knows both channels exist.
 */
import { device } from '@bundled/yaar';
import { QUALITY_PRESETS, quality, setLiveTabs, setLiveStatus } from './state';
import {
  getSocket,
  setSocket,
  getCanvas,
  setDesiredTab,
  resetFrameClock,
  isLiveConnected,
  send,
} from './context';
import { seedCanvas } from './seed';
import { screencastUrl } from '../endpoints';
import { updateUrlBar } from '../store';
import { resetStats, startStatsClock, stopStatsClock } from './stats';
import { startFallback, stopFallback } from './fallback';
import { paintFrame } from './paint';
import { upsertTab, removeTab, followTab } from './tabs';
import { placeAnchor, reportNoCaret, resetIme, setRemoteEditable } from './ime';
import { syncViewport } from './input';
import { decodableCodecs, resetVideo } from './video';

/**
 * A text frame from the server. Every field is optional because `t` decides which
 * ones are present; the shape is ours on both ends, so it is typed rather than
 * validated (unlike the SSE stream in schema.ts, which a *different* server route
 * feeds and whose frames drive the URL bar).
 */
interface ControlFrame {
  t?: string;
  action?: string;
  browserId?: string;
  url?: string;
  title?: string;
  x?: number;
  y?: number;
  h?: number;
  found?: boolean;
  editable?: boolean;
  codec?: string;
}

/** Bumped by every connect and disconnect, so a connect that awaited the codec probe can tell it was overtaken. */
let connectAttempt = 0;

/** What `ready` said the stream is, for the status line: `AV1`, `JPEG`, … */
let streamCodec = '';

const CODEC_NAMES: Record<string, string> = {
  av01: 'AV1',
  avc1: 'H.264',
  vp09: 'VP9',
  jpeg: 'JPEG',
};

/**
 * Whether the window is out of sight — minimized, on another monitor, or the whole
 * page backgrounded (`device.visible` folds all three).
 *
 * A hidden live window used to go on streaming at full rate: Chrome encoding a JPEG
 * per repaint, the socket carrying it, and a canvas nobody could see painting it.
 * Paused, the server releases the screencast while the socket stays up, so the tab
 * strip, the counters and the input path all survive the hide.
 */
let hidden = !device.get().visible;
/** The tab a connect asked for while hidden; opened when the window comes back. */
let pendingTab: string | null = null;
/** The server has been told `pause` on this socket and not yet `resume`. */
let serverPaused = false;

device.onChange(({ visible }) => {
  if (visible === !hidden) return;
  hidden = !visible;
  if (hidden) {
    if (isLiveConnected()) pauseStream();
    return;
  }
  if (pendingTab) {
    const tab = pendingTab;
    pendingTab = null;
    connectLive(tab);
  } else if (serverPaused) {
    resumeStream();
  }
});

function pauseStream(): void {
  if (serverPaused) return;
  serverPaused = true;
  send({ t: 'pause' });
  stopStatsClock();
  stopFallback();
  setLiveStatus('Paused (window hidden)');
}

function resumeStream(): void {
  serverPaused = false;
  send({ t: 'resume' });
  // The pause is not the stream's to be judged on: counters start over, as on a tab switch.
  resetStats();
  resetFrameClock();
  startStatsClock();
  startFallback();
  setLiveStatus('Resuming…');
}

export function connectLive(browserId: string): void {
  disconnectLive();
  if (hidden) {
    // Nothing to stream to. The server's pause would only land after `ready` anyway,
    // by which point one screencast has already been started for nobody.
    pendingTab = browserId;
    setLiveStatus('Paused (window hidden)');
    return;
  }
  const attempt = ++connectAttempt;
  setLiveStatus('Connecting…');
  // Asked once per page, so only the first connect waits on it.
  void decodableCodecs().then((codecs) => {
    if (attempt !== connectAttempt) return;
    if (hidden) {
      pendingTab = browserId;
      setLiveStatus('Paused (window hidden)');
      return;
    }
    openSocket(browserId, codecs);
  });
}

function openSocket(browserId: string, codecs: string[]): void {
  const preset = QUALITY_PRESETS[quality()];
  const ws = new WebSocket(screencastUrl(browserId, preset.quality, preset.maxWidth, codecs));
  ws.binaryType = 'arraybuffer';
  setSocket(ws);
  setDesiredTab(browserId);
  resetFrameClock();
  setLiveTabs([{ browserId, url: '', title: '' }]);
  setLiveStatus('Connecting…');
  resetStats();
  startStatsClock();
  startFallback();

  ws.onopen = () => setLiveStatus('Waiting for first frame…');

  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      handleControlFrame(e.data);
      return;
    }
    void paintFrame(e.data as ArrayBuffer);
  };

  ws.onerror = () => setLiveStatus('Stream error');

  ws.onclose = (e) => {
    if (getSocket() === ws) setSocket(null);
    setLiveStatus(e.reason || (e.code === 1000 ? 'Stream closed' : `Stream closed (${e.code})`));
  };
}

export function disconnectLive(): void {
  connectAttempt++;
  const ws = getSocket();
  setSocket(null);
  resetVideo();
  streamCodec = '';
  pendingTab = null;
  serverPaused = false;
  setDesiredTab(null);
  resetFrameClock();
  stopStatsClock();
  stopFallback();
  setLiveTabs([]);
  resetIme();
  if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, 'left live mode');
}

function handleControlFrame(text: string): void {
  try {
    const msg = JSON.parse(text) as ControlFrame;
    if (msg.t === 'caret') {
      setRemoteEditable(msg.editable === true);
      if (typeof msg.x === 'number' && typeof msg.y === 'number') {
        placeAnchor(msg.x, msg.y, msg.h ?? 16);
      } else if (msg.found === false) {
        reportNoCaret();
      }
      return;
    }
    if (msg.t === 'tab') {
      if (!msg.browserId) return;
      if (msg.action === 'opened') {
        upsertTab({ browserId: msg.browserId, url: msg.url ?? '', title: msg.title ?? '' });
      } else if (msg.action === 'closed') {
        removeTab(msg.browserId);
      }
      return;
    }
    if (msg.t === 'tabError') {
      setLiveStatus('That tab is gone');
      return;
    }
    // The server gave up on video for this socket; the frames that follow are JPEGs.
    if (msg.t === 'codec') {
      resetVideo();
      streamCodec = msg.codec ?? 'jpeg';
      if (!serverPaused) setLiveStatus(liveLabel());
      return;
    }
    if (msg.t === 'ready') {
      if (msg.codec) streamCodec = msg.codec;
      // Hidden between connecting and now: `pause` is only heard once the server has
      // registered the socket, and `ready` is the first frame that proves it has.
      if (hidden && !serverPaused) pauseStream();
      else if (!serverPaused) setLiveStatus(liveLabel());
      if (msg.browserId) {
        // `ready` is the server's answer both to a fresh connection and to an
        // `attach`, so it is the one place that always knows which target the
        // stream is on now.
        setDesiredTab(msg.browserId);
        followTab(msg.browserId, msg.url ?? '', msg.title ?? '');
        // Show that target's pixels without waiting for it to repaint: a page
        // sitting still emits no frames at all, which is a blank canvas on entry
        // and a stale one after a tab switch. Dropped by seed.ts if a real frame
        // lands first.
        void seedCanvas(msg.browserId);
      }
      if (msg.url) updateUrlBar(msg.url, msg.title);
      // Entering live mode is itself a resize, and the ResizeObserver will not say
      // so: it fires once at observe time — while live mode is still off — and then
      // only on an actual geometry change. Without this the remote page stays at
      // whatever viewport it was opened with and the canvas just scales it.
      const area = getCanvas()?.parentElement?.getBoundingClientRect();
      if (area) syncViewport(area.width, area.height);
    }
  } catch {
    /* the only text frames are ours; a malformed one is not worth a channel teardown */
  }
}

function liveLabel(): string {
  const name = CODEC_NAMES[streamCodec];
  return name ? `Live · ${name}` : 'Live';
}
