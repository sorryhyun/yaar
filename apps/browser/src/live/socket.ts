/**
 * The screencast socket: open it, route what comes back, close it.
 *
 * Binary frames are pixels (paint.ts); text frames are the small control
 * protocol below, which is the only thing that knows both channels exist.
 */
import { QUALITY_PRESETS, quality, setLiveTabs, setLiveStatus } from './state';
import { getSocket, setSocket, getCanvas, setDesiredTab, resetFrameClock } from './context';
import { seedCanvas } from './seed';
import { screencastUrl } from '../endpoints';
import { updateUrlBar } from '../store';
import { resetStats, startStatsClock, stopStatsClock } from './stats';
import { startFallback, stopFallback } from './fallback';
import { paintFrame } from './paint';
import { upsertTab, removeTab, followTab } from './tabs';
import { placeAnchor, reportNoCaret, resetIme } from './ime';
import { syncViewport } from './input';

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
}

export function connectLive(browserId: string): void {
  disconnectLive();
  const preset = QUALITY_PRESETS[quality()];
  const ws = new WebSocket(screencastUrl(browserId, preset.quality, preset.maxWidth));
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
  const ws = getSocket();
  setSocket(null);
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
    if (msg.t === 'ready') {
      setLiveStatus('Live');
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
