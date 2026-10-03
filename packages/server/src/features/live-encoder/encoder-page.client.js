/* global document, WebSocket, VideoEncoder, VideoFrame, OffscreenCanvas, createImageBitmap, Blob, TextEncoder, TextDecoder */
// The live-stream encoder page: turns a browser tab's screencast JPEGs into video.
//
// This file is browser JavaScript, not server code. `encoder.ts` imports it as text,
// serves it inline at `/api/live-encoder/page`, and opens it in one background tab of
// the server's own headless Chrome. That one tab encodes every live viewer's stream,
// each in its own `VideoEncoder`.
//
// Both directions use the screencast's envelope, one binary message per frame:
//
//   [u32 LE headerLen][header JSON][payload]
//
//   down  {op:'frame', id, ts}                         + JPEG
//   up    {op:'chunk', id, ts, key, codec, cw, ch}     + encoded chunk
//
// Control messages are JSON text. Down: `open {id, family}`, `close {id}`, `key {id}`.
// Up: `hello {codecs}` once, `error {id, message}`, and `skip {id, ts}` for a frame that
// was not encoded, so the server can forget its metadata.

const cfg = JSON.parse(document.getElementById('cfg').textContent);

// Keep in step with CODEC_FAMILIES in encoder.ts and with apps/browser/src/live/video.ts.
// Measured in docs/proposals/browser_proposal.md: `contentHint: 'text'` is what turns on
// the software encoders' screen-content tools, and without it they blur text at any
// bitrate. Software H.264 (OpenH264) is never offered: it ignores its target and blurs.
const CODECS = {
  av01: {
    codec: 'av01.0.12M.08',
    hardwareAcceleration: 'prefer-software',
    contentHint: 'text',
  },
  avc1: {
    codec: 'avc1.640034',
    hardwareAcceleration: 'prefer-hardware',
    avc: { format: 'annexb' },
  },
  vp09: {
    codec: 'vp09.00.51.08',
    hardwareAcceleration: 'prefer-software',
    contentHint: 'text',
  },
};

// A ceiling, not a target: below what the motion needs, quality falls off a cliff
// rather than degrading, and VBR spends far less than this when the page allows.
const BITRATE = 8_000_000;
// Frames already waiting in an encoder. Past this one is skipped rather than queued:
// a backlog here is latency the human feels as a page that answers late.
const MAX_QUEUE = 2;

const enc = new TextEncoder();
const dec = new TextDecoder();

function configFor(family, width, height) {
  return {
    ...CODECS[family],
    width,
    height,
    bitrate: BITRATE,
    bitrateMode: 'variable',
    framerate: 60,
    latencyMode: 'realtime',
  };
}

async function probe() {
  const out = [];
  for (const family of Object.keys(CODECS)) {
    const support = await VideoEncoder.isConfigSupported(configFor(family, 1280, 800)).catch(
      () => null,
    );
    if (support?.supported) out.push(family);
  }
  return out;
}

// The first session of an encoder pays its start-up (0.5–1.3 s once measured for a
// hardware one). Paid here, before `hello`, rather than on a viewer's first frame.
async function warmUp(family) {
  const encoder = new VideoEncoder({ output: () => {}, error: () => {} });
  try {
    encoder.configure(configFor(family, 1280, 800));
    const canvas = new OffscreenCanvas(1280, 800);
    canvas.getContext('2d').fillRect(0, 0, 1280, 800);
    const frame = new VideoFrame(canvas, { timestamp: 0 });
    encoder.encode(frame, { keyFrame: true });
    frame.close();
    await encoder.flush();
  } catch {
    /* a failed warm-up costs the first viewer a slow frame, nothing more */
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}

let ws;

function sendText(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendBinary(header, payload) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const h = enc.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + h.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, h.byteLength, true);
  out.set(h, 4);
  out.set(payload, 4 + h.byteLength);
  ws.send(out);
}

/** id → { id, family, encoder, w, h, out, key, chain, dead } */
const streams = new Map();

function fail(s, message) {
  if (s.dead) return;
  s.dead = true;
  streams.delete(s.id);
  if (s.encoder && s.encoder.state !== 'closed') s.encoder.close();
  sendText({ op: 'error', id: s.id, message });
}

function emit(s, chunk, metadata) {
  if (s.dead) return;
  // A key chunk after a (re)configure carries the size it was encoded at; frames still
  // in flight from before a resize must not be labelled with the new one.
  const config = metadata?.decoderConfig;
  if (config) s.out = { codec: config.codec, cw: config.codedWidth, ch: config.codedHeight };
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  sendBinary(
    {
      op: 'chunk',
      id: s.id,
      ts: chunk.timestamp,
      key: chunk.type === 'key',
      codec: s.out.codec,
      cw: s.out.cw,
      ch: s.out.ch,
    },
    data,
  );
}

async function encodeFrame(s, ts, jpeg) {
  if (s.dead) return;
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
  } catch {
    sendText({ op: 'skip', id: s.id, ts });
    return;
  }
  if (s.dead) {
    bitmap.close();
    return;
  }
  // 4:2:0 wants even dimensions. A remote viewport is whatever size the window is,
  // so an odd edge loses one pixel column or row rather than the stream.
  const w = bitmap.width & ~1;
  const h = bitmap.height & ~1;
  if (!s.encoder || w !== s.w || h !== s.h) {
    const config = configFor(s.family, w, h);
    const support = await VideoEncoder.isConfigSupported(config).catch(() => null);
    if (!support?.supported || s.dead) {
      bitmap.close();
      if (!s.dead) fail(s, `${s.family} cannot encode ${w}x${h}`);
      return;
    }
    s.encoder ??= new VideoEncoder({
      output: (chunk, metadata) => emit(s, chunk, metadata),
      error: (err) => fail(s, String(err?.message ?? err)),
    });
    s.encoder.configure(config);
    s.w = w;
    s.h = h;
    s.out ??= { codec: CODECS[s.family].codec, cw: w, ch: h };
    s.key = true;
  }
  if (s.encoder.encodeQueueSize >= MAX_QUEUE) {
    bitmap.close();
    sendText({ op: 'skip', id: s.id, ts });
    return;
  }
  const frame = new VideoFrame(bitmap, {
    timestamp: ts,
    visibleRect: { x: 0, y: 0, width: w, height: h },
  });
  bitmap.close();
  try {
    s.encoder.encode(frame, { keyFrame: s.key });
    s.key = false;
  } finally {
    frame.close();
  }
}

function onControl(msg) {
  if (msg.op === 'open' && CODECS[msg.family]) {
    streams.set(msg.id, {
      id: msg.id,
      family: msg.family,
      encoder: null,
      w: 0,
      h: 0,
      out: null,
      key: true,
      chain: Promise.resolve(),
      dead: false,
    });
    return;
  }
  const s = streams.get(msg.id);
  if (!s) return;
  if (msg.op === 'key') {
    s.key = true;
  } else if (msg.op === 'close') {
    s.dead = true;
    streams.delete(s.id);
    if (s.encoder && s.encoder.state !== 'closed') s.encoder.close();
  }
}

function onFrame(buf) {
  const view = new DataView(buf);
  const headerLen = view.getUint32(0, true);
  const header = JSON.parse(dec.decode(new Uint8Array(buf, 4, headerLen)));
  const s = streams.get(header.id);
  if (!s || header.op !== 'frame') return;
  const jpeg = new Uint8Array(buf, 4 + headerLen);
  // One chain per stream: `createImageBitmap` is async, and two frames decoding at
  // once could reach the encoder out of order.
  s.chain = s.chain
    .then(() => encodeFrame(s, header.ts, jpeg))
    .catch((err) => fail(s, String(err?.message ?? err)));
}

async function main() {
  const codecs = typeof VideoEncoder === 'undefined' ? [] : await probe();
  if (codecs.length) await warmUp(codecs[0]);
  ws = new WebSocket(cfg.wsUrl);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => sendText({ op: 'hello', codecs });
  ws.onmessage = (e) => {
    try {
      if (typeof e.data === 'string') onControl(JSON.parse(e.data));
      else onFrame(e.data);
    } catch {
      /* both ends are ours; a malformed message is dropped, not fatal */
    }
  };
  ws.onclose = () => {
    for (const s of streams.values()) {
      if (s.encoder && s.encoder.state !== 'closed') s.encoder.close();
    }
    streams.clear();
  };
}

void main();
