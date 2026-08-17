/**
 * Live browser screencast WebSocket — the pre-P0 spike.
 *
 * One socket per (browser app window, browserId). Down the socket go CDP
 * screencast frames; up it come the human's raw pointer/key events, which are
 * dispatched into the *same* CDP session the agent drives. That sharing is the
 * point, not an accident — see `docs/proposals/Interactive Browser — YAAR-side
 * requirements.md`.
 *
 * This is deliberately NOT the sanctioned stream primitive that proposal calls
 * for (work item 1): there is no `app.json` stream declaration, no per-window
 * scoping beyond the iframe token, no capture-mode UI. It exists to answer one
 * question — does remote render + input forwarding feel good in the hand? — and
 * carries the counters that answer it. P0 replaces it.
 *
 * The `ime` / `caret` messages below are the second probe riding the same socket:
 * whether a CJK composition survives the trip (work item 3, the one P0 item that
 * can sink the phase). Same status — measure first, productionize in P0.
 *
 * Frame wire format, one binary message per frame:
 *
 *   [uint32 LE headerLen][headerLen bytes of UTF-8 JSON][JPEG bytes]
 *
 * The header is per-frame rather than sent-on-change because `sentAt` is what
 * makes end-to-end latency measurable at the canvas.
 *
 * Dispatched from `createWsHandlers` in `server.ts` when `ws.data.kind === 'screencast'`.
 */

import type { ServerWebSocket } from 'bun';
import type { WsData } from './server.js';
import { getHeadlessBrowser } from '../lib/browser/index.js';
import type {
  BrowserSession,
  ScreencastFrame,
  RawMouseEvent,
  RawKeyEvent,
} from '../lib/browser/session.js';
import { createLogger } from '../observability/log.js';

const log = createLogger('screencast');

/**
 * Stop queuing frames once this many bytes are still unsent.
 *
 * A slow link (a phone over Tailscale) must fall behind in *frame rate*, not in
 * time: queuing every frame Chrome produces would grow an unbounded backlog and
 * the human would end up steering a page as it looked seconds ago. One JPEG at
 * quality 60 of a 1280×800 viewport is ~50–150 KB, so this is roughly "at most
 * two frames in flight".
 */
const MAX_BUFFERED_BYTES = 256 * 1024;

interface ViewerState {
  session: BrowserSession;
  onFrame: (frame: ScreencastFrame) => void;
  onClosed: () => void;
  seq: number;
  sent: number;
  dropped: number;
  bytes: number;
  startedAt: number;
}

const viewers = new WeakMap<ServerWebSocket<WsData>, ViewerState>();

export async function handleScreencastOpen(ws: ServerWebSocket<WsData>): Promise<void> {
  const browserId = ws.data.browserId;
  const session = browserId ? getHeadlessBrowser().getSession(browserId) : undefined;
  if (!session) {
    // 1008 (policy violation) rather than a silent close: the app shows the reason.
    ws.close(1008, `No browser session ${browserId ?? '(none)'}`);
    return;
  }

  const state: ViewerState = {
    session,
    onFrame: () => {},
    onClosed: () => {},
    seq: 0,
    sent: 0,
    dropped: 0,
    bytes: 0,
    startedAt: Date.now(),
  };

  state.onFrame = (frame: ScreencastFrame) => {
    if (ws.readyState !== 1) return;
    if (ws.getBufferedAmount() > MAX_BUFFERED_BYTES) {
      state.dropped++;
      return;
    }
    const jpeg = Buffer.from(frame.data, 'base64');
    const m = frame.metadata;
    const header = Buffer.from(
      JSON.stringify({
        seq: state.seq++,
        sentAt: Date.now(),
        w: m.deviceWidth,
        h: m.deviceHeight,
        top: m.offsetTop,
        psf: m.pageScaleFactor,
        sx: m.scrollOffsetX,
        sy: m.scrollOffsetY,
        dropped: state.dropped,
      }),
      'utf8',
    );
    const out = Buffer.allocUnsafe(4 + header.length + jpeg.length);
    out.writeUInt32LE(header.length, 0);
    header.copy(out, 4);
    jpeg.copy(out, 4 + header.length);
    ws.send(out);
    state.sent++;
    state.bytes += out.length;
  };

  state.onClosed = () => {
    if (ws.readyState === 1) ws.close(1000, 'Browser session closed');
  };

  session.on('screencastFrame', state.onFrame);
  session.on('closed', state.onClosed);
  viewers.set(ws, state);

  try {
    // The knob the remote-mode question turns. Chrome's screencast has exactly two
    // levers — JPEG quality and a long-edge cap — and the proposal's claim that
    // "quality ramping on the existing screencast is expected to be sufficient"
    // is only testable if the spike can turn them from the app.
    //
    // Refcounted, so the *first* viewer's settings hold for everyone until the
    // last one leaves. That is wrong in general and irrelevant here: the app
    // reconnects the socket to change quality, and there is one viewer.
    await session.startScreencast({
      quality: ws.data.screencastQuality ?? 60,
      ...(ws.data.screencastMaxWidth ? { maxWidth: ws.data.screencastMaxWidth } : {}),
    });
  } catch (err) {
    log.warn('failed to start screencast', { browserId, err });
    ws.close(1011, 'Failed to start screencast');
    return;
  }

  // Tells the app it is live, and gives it the viewport before the first frame —
  // an empty canvas can be sized correctly rather than jumping on frame one.
  ws.send(
    JSON.stringify({
      t: 'ready',
      browserId,
      url: session.currentUrl,
      title: session.currentTitle,
    }),
  );
  log.info('viewer attached', { browserId });
}

export function handleScreencastMessage(ws: ServerWebSocket<WsData>, data: string | Buffer): void {
  const state = viewers.get(ws);
  if (!state) return;

  let msg: { t?: string } & Record<string, unknown>;
  try {
    msg = JSON.parse(typeof data === 'string' ? data : data.toString());
  } catch {
    return;
  }

  // Every dispatch is fire-and-forget. Awaiting the CDP round trip would serialize
  // the input stream behind the page's own event handling, which is exactly the
  // lag this spike is trying to measure the absence of.
  switch (msg.t) {
    case 'mouse': {
      const e = readMouse(msg);
      if (e) state.session.dispatchMouse(e).catch(() => {});
      return;
    }
    case 'key': {
      const e = readKey(msg);
      if (e) state.session.dispatchKey(e).catch(() => {});
      return;
    }
    case 'text': {
      if (typeof msg.text === 'string' && msg.text.length > 0 && msg.text.length <= 4096) {
        state.session.insertText(msg.text).catch(() => {});
      }
      return;
    }
    // The IME probe (work item 3). `text` here is a *preedit*, not a commit — the
    // human's IME runs locally and sends already-composed text; committing comes
    // back through `text` above. An empty string is the cancel.
    case 'ime': {
      if (typeof msg.text === 'string' && msg.text.length <= 4096) {
        state.session.setComposition(msg.text, num(msg.selStart), num(msg.selEnd)).catch(() => {});
      }
      return;
    }
    // Asked for on composition start, answered once: the app parks its hidden IME
    // anchor here so the OS draws the candidate window under the remote caret.
    case 'caret': {
      state.session
        .caretRect()
        .then((rect) => {
          if (ws.readyState !== 1) return;
          // A miss is an answer too — "the page would not say where its caret is"
          // is precisely what the probe needs to hear, and silence would read as a
          // dropped message instead.
          ws.send(JSON.stringify(rect ? { t: 'caret', ...rect } : { t: 'caret', found: false }));
        })
        .catch(() => {});
      return;
    }
    case 'viewport': {
      const w = num(msg.width);
      const h = num(msg.height);
      if (w !== undefined && h !== undefined && w > 0 && h > 0 && w <= 8192 && h <= 8192) {
        state.session.setViewport(w, h).catch(() => {});
      }
      return;
    }
  }
}

export function handleScreencastClose(ws: ServerWebSocket<WsData>): void {
  const state = viewers.get(ws);
  if (!state) return;
  viewers.delete(ws);

  state.session.off('screencastFrame', state.onFrame);
  state.session.off('closed', state.onClosed);
  void state.session.stopScreencast().catch(() => {});

  // The spike's whole deliverable. `YAAR_LOG_LEVEL=info` already shows it.
  const seconds = Math.max(0.001, (Date.now() - state.startedAt) / 1000);
  log.info('viewer detached', {
    browserId: ws.data.browserId,
    frames: state.sent,
    dropped: state.dropped,
    fps: Number((state.sent / seconds).toFixed(1)),
    kbps: Number(((state.bytes * 8) / seconds / 1000).toFixed(0)),
    seconds: Number(seconds.toFixed(1)),
  });
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const MOUSE_TYPES = new Set(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel']);
const MOUSE_BUTTONS = new Set(['none', 'left', 'middle', 'right', 'back', 'forward']);
const KEY_TYPES = new Set(['keyDown', 'keyUp', 'rawKeyDown', 'char']);

/** Field-by-field, because the sender is an iframe and CDP `Input` is not a passthrough. */
function readMouse(msg: Record<string, unknown>): RawMouseEvent | null {
  const type = msg.type;
  const x = num(msg.x);
  const y = num(msg.y);
  if (typeof type !== 'string' || !MOUSE_TYPES.has(type) || x === undefined || y === undefined) {
    return null;
  }
  const button =
    typeof msg.button === 'string' && MOUSE_BUTTONS.has(msg.button) ? msg.button : 'none';
  return {
    type: type as RawMouseEvent['type'],
    x,
    y,
    button: button as RawMouseEvent['button'],
    buttons: num(msg.buttons) ?? 0,
    clickCount: num(msg.clickCount) ?? 0,
    modifiers: num(msg.modifiers) ?? 0,
    deltaX: num(msg.deltaX) ?? 0,
    deltaY: num(msg.deltaY) ?? 0,
  };
}

function readKey(msg: Record<string, unknown>): RawKeyEvent | null {
  const type = msg.type;
  if (typeof type !== 'string' || !KEY_TYPES.has(type)) return null;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length <= 64 ? v : undefined;
  return {
    type: type as RawKeyEvent['type'],
    modifiers: num(msg.modifiers) ?? 0,
    text: str(msg.text),
    unmodifiedText: str(msg.unmodifiedText),
    key: str(msg.key),
    code: str(msg.code),
    windowsVirtualKeyCode: num(msg.windowsVirtualKeyCode),
  };
}
