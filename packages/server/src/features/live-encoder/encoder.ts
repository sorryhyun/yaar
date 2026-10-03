/**
 * Live-stream video encoding, done in the server's own Chrome.
 *
 * ## Why
 *
 * The Browser app's live mode streamed every repaint as a full JPEG: ~80 Mbps on a
 * fast scroll at 1280×800. A video codec carries the same scroll at ~3 Mbps and looks
 * better (`docs/proposals/browser_proposal.md` has the numbers). The server already
 * runs a Chrome, and WebCodecs there brings every encoder that machine has — software
 * AV1 everywhere, hardware H.264 where the platform offers it — with no new dependency.
 *
 * ## Shape
 *
 * One pinned tab on `/api/live-encoder/page`, opened on the first video viewer and
 * closed after {@link IDLE_CLOSE_MS} with none. Its script dials `/api/live-encoder/ws`
 * and says which codecs it can encode. Each viewer then gets a {@link VideoStream}: the
 * screencast handler feeds it JPEGs and gets encoded chunks back. One tab serves every
 * stream, each with its own encoder, so a second viewer costs an encoder, not a tab.
 *
 * Opening the tab activates it, and Chrome composites only the frontmost tab. A viewer
 * must therefore open its stream *before* its screencast brings the viewed tab to the
 * front, which is the order `handleScreencastOpen` uses.
 *
 * ## Trust
 *
 * The page and its socket are keyed by a per-tab secret: it is our own code in our own
 * browser, and nothing an app can address. The page reaches no other route.
 */

import type { ServerWebSocket } from 'bun';
import { randomBytes } from 'node:crypto';
import encoderScript from './encoder-page.client.js' with { type: 'text' };
import type { WsData } from '../../websocket/server.js';
import { getHeadlessBrowser } from '../../lib/browser/index.js';
import { generateConnectionId } from '../../session/broadcast-center.js';
import { APP_ORIGIN_HOST, getPort } from '../../config.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('live-encoder');

/**
 * The codecs a stream may use, in the order they are preferred. Keep in step with
 * `CODECS` in `encoder-page.client.js` and with `apps/browser/src/live/video.ts`.
 *
 * AV1 software leads because it measured best everywhere it was measured, hardware
 * H.264 on macOS included. Hardware H.264 is next for a host whose CPU struggles with
 * AV1. VP9 software is the last resort.
 */
export const CODEC_FAMILIES = ['av01', 'avc1', 'vp09'] as const;
export type CodecFamily = (typeof CODEC_FAMILIES)[number];

/** How long the tab gets to load, probe its encoders and dial back. */
const HOST_READY_TIMEOUT_MS = 15_000;
/** How long the tab outlives its last stream, so a reconnect does not pay start-up again. */
const IDLE_CLOSE_MS = 5 * 60_000;
/** After a failed start, how long every viewer stays on JPEG before another try. */
const RETRY_AFTER_MS = 60_000;

const BROWSER_ID = 'live-encoder';

/** The comma list a viewer sends as `?codecs=`, reduced to families we know. */
export function parseCodecFamilies(raw: string | null): CodecFamily[] {
  if (!raw) return [];
  const known = new Set<string>(CODEC_FAMILIES);
  return [...new Set(raw.split(','))].filter((c): c is CodecFamily => known.has(c));
}

/** The first family in our order that both the encoder tab and the viewer support. */
export function pickCodec(
  encodable: readonly CodecFamily[],
  decodable: readonly CodecFamily[],
): CodecFamily | null {
  return CODEC_FAMILIES.find((c) => encodable.includes(c) && decodable.includes(c)) ?? null;
}

// ── Wire ─────────────────────────────────────────────────────────────────────

/** `[uint32 LE headerLen][JSON header][payload]`, the screencast envelope. */
export function envelope(header: Record<string, unknown>, payload: Uint8Array): Buffer {
  const h = Buffer.from(JSON.stringify(header), 'utf8');
  const out = Buffer.allocUnsafe(4 + h.length + payload.byteLength);
  out.writeUInt32LE(h.length, 0);
  h.copy(out, 4);
  out.set(payload, 4 + h.length);
  return out;
}

function readEnvelope(data: Buffer): { header: Record<string, unknown>; payload: Buffer } | null {
  if (data.length < 4) return null;
  const headerLen = data.readUInt32LE(0);
  if (headerLen + 4 > data.length) return null;
  try {
    return {
      header: JSON.parse(data.subarray(4, 4 + headerLen).toString('utf8')),
      payload: data.subarray(4 + headerLen),
    };
  } catch {
    return null;
  }
}

// ── Streams ──────────────────────────────────────────────────────────────────

export interface EncodedChunk {
  /** The timestamp the frame was fed with (µs). */
  ts: number;
  key: boolean;
  /** The full codec string a decoder is configured with. */
  codec: string;
  /** Coded size: the frame's device px, rounded down to even. */
  cw: number;
  ch: number;
  data: Buffer;
}

export interface VideoStreamHandlers {
  onChunk(chunk: EncodedChunk): void;
  /** A fed frame that will produce no chunk. */
  onSkip(ts: number): void;
  /** The stream is dead; fall back to JPEG. Never called after `close()`. */
  onError(reason: string): void;
}

export interface VideoStream {
  readonly family: CodecFamily;
  feed(ts: number, jpeg: Buffer): void;
  requestKeyframe(): void;
  close(): void;
}

interface StreamEntry {
  handlers: VideoStreamHandlers;
  closed: boolean;
}

interface Host {
  secret: string;
  ws: ServerWebSocket<WsData> | null;
  /** Resolves with the encodable codecs once the page says hello, or `null` if it never does. */
  ready: Promise<CodecFamily[] | null>;
  resolveReady: (codecs: CodecFamily[] | null) => void;
  streams: Map<string, StreamEntry>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

let host: Host | null = null;
let failedAt = 0;

/** For the ws handlers and tests. */
export function liveEncoderStreamCount(): number {
  return host?.streams.size ?? 0;
}

/**
 * A video stream for one viewer, or `null` when it should stay on JPEG: it offered no
 * codec we encode, or the encoder tab cannot be had.
 */
export async function openVideoStream(
  decodable: readonly CodecFamily[],
  handlers: VideoStreamHandlers,
): Promise<VideoStream | null> {
  if (decodable.length === 0) return null;
  const h = ensureHost();
  if (!h) return null;
  const encodable = await h.ready;
  if (!encodable || h.closed || !h.ws) return null;
  const family = pickCodec(encodable, decodable);
  if (!family) return null;

  const id = randomBytes(6).toString('hex');
  const entry: StreamEntry = { handlers, closed: false };
  h.streams.set(id, entry);
  if (h.idleTimer) clearTimeout(h.idleTimer);
  h.idleTimer = null;
  h.ws.send(JSON.stringify({ op: 'open', id, family }));

  return {
    family,
    feed(ts, jpeg) {
      if (entry.closed || !h.ws) return;
      // 0 is Bun's "dropped". The encoder never saw the frame, so nothing downstream
      // is corrupted; the viewer just gets one frame fewer.
      if (h.ws.send(envelope({ op: 'frame', id, ts }, jpeg)) === 0) handlers.onSkip(ts);
    },
    requestKeyframe() {
      if (!entry.closed) h.ws?.send(JSON.stringify({ op: 'key', id }));
    },
    close() {
      if (entry.closed) return;
      entry.closed = true;
      h.streams.delete(id);
      h.ws?.send(JSON.stringify({ op: 'close', id }));
      if (h.streams.size === 0) armIdleClose(h);
    },
  };
}

function ensureHost(): Host | null {
  if (host && !host.closed) return host;
  if (Date.now() - failedAt < RETRY_AFTER_MS) return null;

  let resolveReady!: (codecs: CodecFamily[] | null) => void;
  const ready = new Promise<CodecFamily[] | null>((r) => (resolveReady = r));
  const h: Host = {
    secret: randomBytes(24).toString('base64url'),
    ws: null,
    ready,
    resolveReady,
    streams: new Map(),
    idleTimer: null,
    closed: false,
  };
  host = h;
  const timer = setTimeout(
    () => teardown(h, 'the encoder tab did not come up in time'),
    HOST_READY_TIMEOUT_MS,
  );
  void ready.then(() => clearTimeout(timer));
  void openTab(h);
  return h;
}

async function openTab(h: Host): Promise<void> {
  try {
    const provider = getHeadlessBrowser();
    if (!(await provider.isAvailable())) {
      teardown(h, 'no Chrome on the server');
      return;
    }
    // Pinned: the idle sweep cannot see this socket's traffic, and an internal tab
    // must not take a user's session slot.
    const { session } = await provider.createSession(BROWSER_ID, { pinned: true });
    if (h.closed) {
      await provider.closeSession(BROWSER_ID).catch(() => {});
      return;
    }
    await session.navigate(
      `http://${APP_ORIGIN_HOST}:${getPort()}/api/live-encoder/page?ch=${h.secret}`,
    );
  } catch (err) {
    teardown(h, `could not open the encoder tab: ${String(err)}`);
  }
}

function armIdleClose(h: Host): void {
  if (h.idleTimer) clearTimeout(h.idleTimer);
  h.idleTimer = setTimeout(() => {
    if (h.streams.size === 0) teardown(h, null);
  }, IDLE_CLOSE_MS);
}

function teardown(h: Host, reason: string | null): void {
  if (h.closed) return;
  h.closed = true;
  if (host === h) host = null;
  if (h.idleTimer) clearTimeout(h.idleTimer);
  h.resolveReady(null);
  if (reason) {
    failedAt = Date.now();
    log.warn('encoder tab ended', { reason, streams: h.streams.size });
  }
  for (const entry of h.streams.values()) {
    if (entry.closed) continue;
    entry.closed = true;
    entry.handlers.onError(reason ?? 'the encoder tab closed');
  }
  h.streams.clear();
  try {
    h.ws?.close(1000, 'encoder closed');
  } catch {
    /* already closed */
  }
  void getHeadlessBrowser()
    .closeSession(BROWSER_ID)
    .catch(() => {});
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/**
 * The two `/api/live-encoder/*` routes. Returns `null` for anything else, `undefined`
 * once the socket has been upgraded, and a `Response` otherwise. Dispatched ahead of
 * the remote-mode auth gate: both are keyed by the tab's secret instead.
 */
export function handleLiveEncoderRoutes(
  req: Request,
  url: URL,
  server: import('bun').Server<WsData>,
): Response | undefined | null {
  if (url.pathname !== '/api/live-encoder/page' && url.pathname !== '/api/live-encoder/ws') {
    return null;
  }
  const h = host;
  if (!h || h.closed || url.searchParams.get('ch') !== h.secret) {
    return new Response('Unknown encoder', { status: 404 });
  }
  if (url.pathname === '/api/live-encoder/page') return encoderPage(h);

  const data: WsData = {
    kind: 'live-encoder',
    connectionId: generateConnectionId(),
    sessionId: null,
    monitorId: null,
  };
  return server.upgrade(req, { data })
    ? undefined
    : new Response('Encoder upgrade failed', { status: 500 });
}

function encoderPage(h: Host): Response {
  const cfg = {
    wsUrl: `ws://${APP_ORIGIN_HOST}:${getPort()}/api/live-encoder/ws?ch=${h.secret}`,
  };
  const nonce = randomBytes(16).toString('base64');
  // `<` escaped so no value can close the JSON's <script> early.
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  const html =
    `<!doctype html><meta charset="utf-8"><title>YAAR live encoder</title>` +
    `<script type="application/json" id="cfg">${json}</script>` +
    `<script type="module" nonce="${nonce}">${encoderScript}</script>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        "connect-src 'self'",
      ].join('; '),
    },
  });
}

// ── Socket ───────────────────────────────────────────────────────────────────

export function handleLiveEncoderOpen(ws: ServerWebSocket<WsData>): void {
  const h = host;
  // A second socket means the tab reloaded, and every encoder in it is gone.
  if (!h || h.closed || h.ws) {
    ws.close(1000, 'gone');
    if (h && h.ws) teardown(h, 'the encoder tab reloaded');
    return;
  }
  h.ws = ws;
}

export function handleLiveEncoderMessage(ws: ServerWebSocket<WsData>, data: string | Buffer): void {
  const h = host;
  if (!h || h.ws !== ws) return;

  if (typeof data === 'string') {
    let msg: { op?: string; id?: string; codecs?: unknown; ts?: unknown; message?: unknown };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.op === 'hello') {
      const codecs = Array.isArray(msg.codecs) ? parseCodecFamilies(msg.codecs.join(',')) : [];
      log.info('encoder tab ready', { codecs });
      h.resolveReady(codecs);
      if (h.streams.size === 0) armIdleClose(h);
      return;
    }
    const entry = h.streams.get(msg.id ?? '');
    if (!entry || entry.closed) return;
    if (msg.op === 'skip' && typeof msg.ts === 'number') {
      entry.handlers.onSkip(msg.ts);
    } else if (msg.op === 'error') {
      entry.closed = true;
      h.streams.delete(msg.id!);
      log.warn('encoder stream failed', { message: String(msg.message) });
      entry.handlers.onError(String(msg.message));
      if (h.streams.size === 0) armIdleClose(h);
    }
    return;
  }

  const parsed = readEnvelope(data);
  if (!parsed || parsed.header.op !== 'chunk') return;
  const { header, payload } = parsed;
  const entry = h.streams.get(String(header.id));
  if (!entry || entry.closed) return;
  entry.handlers.onChunk({
    ts: Number(header.ts),
    key: header.key === true,
    codec: String(header.codec),
    cw: Number(header.cw),
    ch: Number(header.ch),
    data: payload,
  });
}

export function handleLiveEncoderClose(ws: ServerWebSocket<WsData>): void {
  const h = host;
  if (h && h.ws === ws) teardown(h, 'the encoder tab closed');
}
