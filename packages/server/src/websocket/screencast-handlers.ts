/**
 * Live browser screencast WebSocket — the pre-P0 spike.
 *
 * One socket per (browser app window, browserId). Down the socket go CDP
 * screencast frames; up it come the human's raw pointer/key events, which are
 * dispatched into the *same* CDP session the agent drives. That sharing is the
 * point, not an accident.
 *
 * This is deliberately NOT a sanctioned stream primitive: there is no
 * `app.json` stream declaration, no per-window scoping beyond the iframe
 * token, no capture-mode UI. It exists to answer one
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
import type { BrowserTabEvent } from '../lib/browser/types.js';
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
  /** The tab currently on the canvas. Follows `attach`, not the socket's URL. */
  browserId: string;
  /**
   * Every tab this viewer is responsible for: the one it opened with, plus each
   * popup opened from one of them. Membership is what decides whether a tab event
   * concerns *this* viewer — two windows watching two unrelated tabs must not grow
   * each other's strips.
   */
  tabs: Set<string>;
  /** The screencast levers, kept so a tab switch restarts at the same quality. */
  quality: number;
  maxWidth: number;
  unsubscribeTabs: () => void;
  /** Serializes switches so two fast clicks can't leave two screencasts running. */
  switching: Promise<void>;
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
  const provider = getHeadlessBrowser();
  // A window asking for its own id is the strongest claim there is that this session
  // should exist — it is the desktop coming back from a reload, or a tab the idle
  // sweep collected while nobody was watching. Revive before refusing; that is the
  // difference between the canvas repainting and it sitting dead on "No browser
  // session 0" (P1, work item 4).
  const session = browserId
    ? (provider.getSession(browserId) ?? (await provider.reviveSession(browserId)))
    : undefined;
  if (!session || !browserId) {
    // 1008 (policy violation) rather than a silent close: the app shows the reason.
    ws.close(1008, `No browser session ${browserId ?? '(none)'}`);
    return;
  }

  const state: ViewerState = {
    session,
    browserId,
    tabs: new Set([browserId]),
    quality: ws.data.screencastQuality ?? 60,
    maxWidth: ws.data.screencastMaxWidth ?? 0,
    unsubscribeTabs: () => {},
    switching: Promise.resolve(),
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

  // The tab under the canvas dying is not automatically the end of the viewing:
  // a popup closing itself should hand the human back to whatever opened it, the
  // way a real browser does. Only a viewer with nowhere left to go loses its socket.
  state.onClosed = () => {
    if (ws.readyState !== 1) return;
    const fallback = pickFallback(state, state.browserId);
    if (fallback) {
      switchTab(ws, state, fallback);
      return;
    }
    ws.close(1000, 'Browser session closed');
  };

  state.unsubscribeTabs = provider.onTabEvent((event) => onTabEvent(ws, state, event));

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
    //
    // Activated first because Chrome composites only the frontmost tab of a
    // window — a screencast on a background target streams nothing (the stall
    // `apps/browser/src/live/fallback.ts` mitigates). Tolerated on failure: the
    // fallback still produces stills. This socket only ever reaches the headless
    // provider, so activation cannot steal focus in a user's own Chrome.
    await session.bringToFront().catch(() => {});
    await session.startScreencast({
      quality: state.quality,
      ...(state.maxWidth ? { maxWidth: state.maxWidth } : {}),
    });
  } catch (err) {
    log.warn('failed to start screencast', { browserId, err });
    state.unsubscribeTabs();
    ws.close(1011, 'Failed to start screencast');
    return;
  }

  // Tells the app it is live, and gives it the viewport before the first frame —
  // an empty canvas can be sized correctly rather than jumping on frame one.
  sendReady(ws, state);
  log.info('viewer attached', { browserId });
}

/** The `ready` frame, sent on attach and again after every tab switch. */
function sendReady(ws: ServerWebSocket<WsData>, state: ViewerState): void {
  if (ws.readyState !== 1) return;
  ws.send(
    JSON.stringify({
      t: 'ready',
      browserId: state.browserId,
      url: state.session.currentUrl,
      title: state.session.currentTitle,
    }),
  );
}

/**
 * A tab this viewer is responsible for opened or closed.
 *
 * A popup is followed rather than merely announced: the human clicked something
 * that opened a window, and a canvas that keeps painting the opener is the bug
 * this whole path exists to fix. The strip is how they get back.
 */
function onTabEvent(ws: ServerWebSocket<WsData>, state: ViewerState, event: BrowserTabEvent): void {
  if (ws.readyState !== 1) return;

  if (event.type === 'opened') {
    if (!event.openerBrowserId || !state.tabs.has(event.openerBrowserId)) return;
    state.tabs.add(event.browserId);
    ws.send(
      JSON.stringify({
        t: 'tab',
        action: 'opened',
        browserId: event.browserId,
        url: event.url,
        title: event.title,
        openerBrowserId: event.openerBrowserId,
      }),
    );
    switchTab(ws, state, event.browserId);
    return;
  }

  if (!state.tabs.has(event.browserId)) return;
  state.tabs.delete(event.browserId);
  ws.send(JSON.stringify({ t: 'tab', action: 'closed', browserId: event.browserId }));
  if (event.browserId !== state.browserId) return;

  // The canvas was on the tab that just died — the `closed` handler will not fire
  // for it if the session was dropped rather than closed, so the fallback is here too.
  const fallback = pickFallback(state, event.browserId, event.openerBrowserId);
  if (fallback) switchTab(ws, state, fallback);
  else ws.close(1000, 'Browser session closed');
}

/** Where to send the canvas when the tab under it goes away: opener first, then any sibling. */
function pickFallback(state: ViewerState, gone: string, opener?: string): string | undefined {
  const preferred = opener ?? state.session.openerBrowserId;
  if (preferred && preferred !== gone && state.tabs.has(preferred)) return preferred;
  for (const id of state.tabs) {
    if (id !== gone) return id;
  }
  return undefined;
}

/**
 * Point this viewer at a different tab, in place.
 *
 * The socket is deliberately not reconnected: it carries the human's input and the
 * spike's latency counters, and a reconnect per popup would blank both. Switches
 * are chained rather than run concurrently — two fast clicks must not leave the
 * abandoned tab still encoding JPEGs for nobody.
 */
function switchTab(ws: ServerWebSocket<WsData>, state: ViewerState, browserId: string): void {
  state.switching = state.switching
    .then(async () => {
      if (ws.readyState !== 1) return;
      if (browserId === state.browserId) return;
      const provider = getHeadlessBrowser();
      const next = provider.getSession(browserId) ?? (await provider.reviveSession(browserId));
      if (!next) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ t: 'tab', action: 'closed', browserId }));
        }
        state.tabs.delete(browserId);
        return;
      }

      const previous = state.session;
      previous.off('screencastFrame', state.onFrame);
      previous.off('closed', state.onClosed);
      await previous.stopScreencast().catch(() => {});

      state.session = next;
      state.browserId = browserId;
      state.tabs.add(browserId);
      next.on('screencastFrame', state.onFrame);
      next.on('closed', state.onClosed);
      // Same reason as on open: only the frontmost tab composites, so switching
      // the canvas to a background tab without activating it streams zero frames.
      await next.bringToFront().catch(() => {});
      await next.startScreencast({
        quality: state.quality,
        ...(state.maxWidth ? { maxWidth: state.maxWidth } : {}),
      });
      // The tab may have navigated itself since it was adopted, and the URL bar the
      // human reads comes from this frame.
      await next.refreshLocation().catch(() => {});
      sendReady(ws, state);
      log.info('viewer switched tab', { browserId });
    })
    .catch((err) => {
      log.warn('failed to switch tab', { browserId, err });
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'tabError', browserId }));
    });
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
    // The tab strip clicking through to another tab. Everything else on this socket
    // — input, IME, viewport — follows `state.session`, so nothing else changes.
    case 'attach': {
      if (typeof msg.browserId === 'string' && msg.browserId) {
        switchTab(ws, state, msg.browserId);
      }
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

  state.unsubscribeTabs();
  // Through the switch chain, so a detach that lands mid-switch stops the tab that
  // actually ends up streaming rather than the one that was streaming when it began.
  void state.switching.then(() => {
    state.session.off('screencastFrame', state.onFrame);
    state.session.off('closed', state.onClosed);
    return state.session.stopScreencast().catch(() => {});
  });

  // The spike's whole deliverable. `YAAR_LOG_LEVEL=info` already shows it.
  const seconds = Math.max(0.001, (Date.now() - state.startedAt) / 1000);
  log.info('viewer detached', {
    browserId: state.browserId,
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
