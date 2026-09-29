/**
 * Remote ML compute: an app's `@bundled/yaar-ml` sessions, run in the server's Chrome.
 *
 * ## Why
 *
 * On macOS the desktop is YAAR's own WKWebView window, and WebKit's WebGPU is markedly
 * slower than Chrome's on the same GPU — anima's DiT step is 3.9 s there and 2.2 s in
 * Chrome, with the GPU ~95% busy in both (`docs/installations/mac_ml.md`). WebKit has
 * no subgroups and no switch that adds them, so no setting in the window closes that
 * gap. The server already runs a Chrome (the Browser app's), so the model runs there:
 * same onnxruntime-web, same app code, only the engine under it changes.
 *
 * ## Shape
 *
 * The app's shim dials `/api/ml-host/connect` (the app side). For each such socket this
 * module opens one headless tab on `/api/ml-host/page`, whose script dials
 * `/api/ml-host/ws` (the host side), and from then on relays binary frames between the
 * two unread. One tab per app socket is what ties GPU memory to the app's lifetime: the
 * iframe goes, its socket closes, the tab closes, and Chrome frees every session in it.
 *
 * Nothing here parses a tensor. The only messages this module writes itself are
 * `{op:'local'}` (use your own engine) and `{op:'gone'}` (the host died), in the same
 * wire format the two ends share (`host-page.client.js`).
 *
 * ## Trust
 *
 * The tab carries the app's own iframe token and nothing more, and forces it onto every
 * same-server URL it fetches, so it can reach exactly what the app could. It is served
 * on the app origin, where a token-less request is refused anyway under isolation. The
 * page and its socket are keyed by a per-channel secret rather than a token because it
 * is our own code in our own browser — nothing the app can address.
 */

import type { ServerWebSocket } from 'bun';
import { randomBytes } from 'node:crypto';
import hostScript from './host-page.client.js' with { type: 'text' };
import type { WsData } from '../../websocket/server.js';
import { getHeadlessBrowser } from '../../lib/browser/index.js';
import { requireBundledApp } from '../../http/access.js';
import { generateConnectionId } from '../../session/broadcast-center.js';
import { APP_ORIGIN_HOST, IS_REMOTE, getPort } from '../../config.js';
import { getRemoteInfo } from '../../lifecycle.js';
import { createLogger } from '../../observability/log.js';

const log = createLogger('ml-host');

/** How long a fresh tab gets to load onnxruntime and dial back before the app gives up. */
const HOST_READY_TIMEOUT_MS = 60_000;

type MlComputeMode = 'auto' | 'chrome' | 'local';

/**
 * `YAAR_ML_COMPUTE`: where an app's yaar-ml sessions run.
 *
 * - `auto` (default) — in the server's Chrome when the server is on macOS and the app is
 *   running in WebKit; that pair is the measured gap, and nothing else is.
 * - `chrome` — always, whatever the app runs in. What a benchmark wants.
 * - `local` — never; every app computes in its own page, as before this existed.
 */
export function mlComputeMode(): MlComputeMode {
  const raw = process.env.YAAR_ML_COMPUTE?.trim().toLowerCase();
  return raw === 'chrome' || raw === 'local' ? raw : 'auto';
}

export function wantsRemoteCompute(engine: string | null): boolean {
  const mode = mlComputeMode();
  if (mode !== 'auto') return mode === 'chrome';
  return process.platform === 'darwin' && engine === 'webkit';
}

// ── Wire ─────────────────────────────────────────────────────────────────────

const pad8 = (n: number) => (n + 7) & ~7;

/** A header-only message as one final frame. See `host-page.client.js` for the format. */
export function controlFrame(header: Record<string, unknown>): Uint8Array {
  const h = new TextEncoder().encode(JSON.stringify({ ...header, b: [] }));
  const out = new Uint8Array(1 + 8 + pad8(h.byteLength));
  new DataView(out.buffer).setUint32(1, h.byteLength, true);
  out.set(h, 9);
  return out;
}

// ── Channels ─────────────────────────────────────────────────────────────────

interface Channel {
  id: string;
  secret: string;
  client: ServerWebSocket<WsData>;
  host: ServerWebSocket<WsData> | null;
  browserId: string;
  iframeToken: string;
  ortVersion: string;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

const channels = new Map<string, Channel>();
const bySecret = new Map<string, Channel>();

/** For the ws handlers and tests. */
export function mlChannelCount(): number {
  return channels.size;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/**
 * The three `/api/ml-host/*` routes. Returns `null` for anything else, `undefined` once
 * the socket has been upgraded, and a `Response` otherwise.
 *
 * Dispatched ahead of the remote-mode auth gate and the app-origin document redirect:
 * the app socket authenticates by iframe token (the screencast route's pattern) and the
 * other two by channel secret, and the page is a document on the app origin on purpose.
 */
export function handleMlHostRoutes(
  req: Request,
  url: URL,
  server: import('bun').Server<WsData>,
): Response | undefined | null {
  if (url.pathname === '/api/ml-host/connect') {
    const auth = requireBundledApp(req, url, 'yaar-ml');
    if (auth instanceof Response) return auth;
    const data: WsData = {
      kind: 'ml-client',
      connectionId: generateConnectionId(),
      sessionId: auth.sessionId,
      monitorId: auth.monitorId ?? null,
      ml: {
        engine: url.searchParams.get('engine'),
        ortVersion: /^[0-9A-Za-z.+-]{1,40}$/.test(url.searchParams.get('v') ?? '')
          ? url.searchParams.get('v')!
          : '',
        iframeToken: auth.token,
        appId: auth.appId,
      },
    };
    return server.upgrade(req, { data })
      ? undefined
      : new Response('ML host upgrade failed', { status: 500 });
  }

  if (url.pathname === '/api/ml-host/ws') {
    const channel = bySecret.get(url.searchParams.get('ch') ?? '');
    if (!channel || channel.closed) return new Response('Unknown channel', { status: 404 });
    const data: WsData = {
      kind: 'ml-host',
      connectionId: generateConnectionId(),
      sessionId: null,
      monitorId: null,
      ml: { channelId: channel.id },
    };
    return server.upgrade(req, { data })
      ? undefined
      : new Response('ML host upgrade failed', { status: 500 });
  }

  if (url.pathname === '/api/ml-host/page') {
    const channel = bySecret.get(url.searchParams.get('ch') ?? '');
    if (!channel || channel.closed) return new Response('Unknown channel', { status: 404 });
    return hostPage(channel);
  }

  return null;
}

function hostPage(channel: Channel): Response {
  const v = channel.ortVersion ? `?v=${encodeURIComponent(channel.ortVersion)}` : '';
  const runtime: Record<string, string> = {};
  for (const file of [
    'ort.webgpu.bundle.min.mjs',
    'ort.wasm.bundle.min.mjs',
    'ort-wasm-simd-threaded.asyncify.mjs',
    'ort-wasm-simd-threaded.asyncify.wasm',
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.wasm',
  ]) {
    runtime[file] = `${hostOrigin()}/api/ml-runtime/${file}${v}`;
  }
  const cfg = {
    wsUrl: `ws://${APP_ORIGIN_HOST}:${getPort()}/api/ml-host/ws?ch=${channel.secret}`,
    runtime,
    iframeToken: channel.iframeToken,
    remoteToken: IS_REMOTE ? (getRemoteInfo()?.token ?? null) : null,
  };
  const nonce = randomBytes(16).toString('base64');
  // `<` escaped so no value can close the JSON's <script> early.
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  const html =
    `<!doctype html><meta charset="utf-8"><title>YAAR ML host</title>` +
    `<script type="application/json" id="cfg">${json}</script>` +
    `<script type="module" nonce="${nonce}">${hostScript}</script>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // Nothing beyond what an app's own page may reach (`http/csp.ts`), so the tab is
      // no wider a door than the iframe that asked for it. `unsafe-eval` for the
      // runtime import, `wasm-unsafe-eval` for onnxruntime's wasm.
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'self' 'nonce-${nonce}' 'unsafe-eval' 'wasm-unsafe-eval' blob:`,
        "connect-src 'self' blob: data:",
        "worker-src 'self' blob:",
      ].join('; '),
    },
  });
}

function hostOrigin(): string {
  return `http://${APP_ORIGIN_HOST}:${getPort()}`;
}

// ── Sockets ──────────────────────────────────────────────────────────────────

function sendOrFail(channel: Channel, to: ServerWebSocket<WsData>, frame: Uint8Array): void {
  // 0 is Bun's "dropped": past the backpressure limit, the frame is gone. A lost
  // fragment would corrupt every message after it, so the channel ends here instead.
  if (to.send(frame) === 0) teardown(channel, 'the relay fell behind and dropped a frame');
}

function decline(ws: ServerWebSocket<WsData>, reason: string): void {
  ws.send(controlFrame({ op: 'local', reason }));
  ws.close(1000, 'local');
}

async function openClient(ws: ServerWebSocket<WsData>): Promise<void> {
  const ml = ws.data.ml!;
  if (!wantsRemoteCompute(ml.engine ?? null)) {
    decline(ws, `YAAR_ML_COMPUTE=${mlComputeMode()} keeps this engine local`);
    return;
  }
  const provider = getHeadlessBrowser();
  if (!(await provider.isAvailable())) {
    decline(ws, 'no Chrome on the server');
    return;
  }
  // The app may already have gone while we looked for a browser; no tab for a dead socket.
  if (ws.readyState !== 1) return;

  const id = randomBytes(6).toString('hex');
  const channel: Channel = {
    id,
    secret: randomBytes(24).toString('base64url'),
    client: ws,
    host: null,
    browserId: `ml-host-${id}`,
    iframeToken: ml.iframeToken!,
    ortVersion: ml.ortVersion ?? '',
    timer: null,
    closed: false,
  };
  channels.set(id, channel);
  bySecret.set(channel.secret, channel);
  ws.data.ml = { ...ml, channelId: id };
  channel.timer = setTimeout(
    () => teardown(channel, 'the ML host tab did not come up in time'),
    HOST_READY_TIMEOUT_MS,
  );

  try {
    const { session } = await provider.createSession(channel.browserId);
    // The idle sweep reads "nobody touched this tab" as "nobody needs it"; this tab is
    // touched by its socket, which the sweep cannot see.
    session.pinned = true;
    if (channel.closed) {
      await provider.closeSession(channel.browserId).catch(() => {});
      return;
    }
    await session.navigate(`${hostOrigin()}/api/ml-host/page?ch=${channel.secret}`);
    log.info('ML host tab opened', { channel: id, app: ml.appId });
  } catch (err) {
    teardown(channel, `could not open the ML host tab: ${String(err)}`);
  }
}

function openHost(ws: ServerWebSocket<WsData>): void {
  const channel = channels.get(ws.data.ml?.channelId ?? '');
  if (!channel || channel.closed) {
    ws.close(1000, 'gone');
    return;
  }
  // A second host socket means the tab reloaded (a renderer crash replayed by the
  // browser session): the first one's sessions died with it, and the app is still
  // holding them. Ending the channel is the only honest answer.
  if (channel.host) {
    teardown(channel, 'the ML host tab reloaded');
    return;
  }
  channel.host = ws;
  if (channel.timer) clearTimeout(channel.timer);
  channel.timer = null;
}

function teardown(channel: Channel, reason: string | null): void {
  if (channel.closed) return;
  channel.closed = true;
  channels.delete(channel.id);
  bySecret.delete(channel.secret);
  if (channel.timer) clearTimeout(channel.timer);
  if (reason) {
    log.warn('ML host channel ended', { channel: channel.id, reason });
    try {
      channel.client.send(controlFrame({ op: 'gone', reason }));
    } catch {
      /* already closed */
    }
  }
  try {
    channel.client.close(1000, 'ml host ended');
  } catch {
    /* already closed */
  }
  try {
    channel.host?.close(1000, 'client ended');
  } catch {
    /* already closed */
  }
  void getHeadlessBrowser()
    .closeSession(channel.browserId)
    .catch(() => {});
}

export function handleMlOpen(ws: ServerWebSocket<WsData>): void | Promise<void> {
  if (ws.data.kind === 'ml-client') return openClient(ws);
  return openHost(ws);
}

export function handleMlMessage(ws: ServerWebSocket<WsData>, data: string | Buffer): void {
  const channel = channels.get(ws.data.ml?.channelId ?? '');
  if (!channel || channel.closed || typeof data === 'string') return;
  const to = ws.data.kind === 'ml-client' ? channel.host : channel.client;
  // The app speaks only after `ready`, which comes from the host, so a frame from the
  // app with no host yet is a protocol violation, not a race.
  if (!to) return;
  sendOrFail(channel, to, data);
}

export function handleMlClose(ws: ServerWebSocket<WsData>): void {
  const channel = channels.get(ws.data.ml?.channelId ?? '');
  if (!channel) return;
  // The app leaving is the normal end, and needs no reason; the host leaving is not.
  teardown(channel, ws.data.kind === 'ml-client' ? null : 'the ML host tab closed');
}
