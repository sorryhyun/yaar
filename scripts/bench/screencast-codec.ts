#!/usr/bin/env bun
/**
 * screencast-codec.ts — what the live browser's stream costs, and what a video codec
 * would cost instead (docs/proposals/browser_proposal.md).
 *
 * Records a CDP screencast of a trackpad-like scroll in a headless Chrome, as lossless
 * PNG, then feeds the same frames, at their recorded timestamps, to WebCodecs
 * `VideoEncoder` in a page of that same Chrome. Each stream is reported with its
 * bitrate, luma PSNR against the PNG reference (decoded back through `VideoDecoder`),
 * and per-frame encode latency. JPEG rows re-encode the reference through the
 * canvas at the live presets' qualities.
 *
 * `--dsf-probe` instead prints the frame-size table behind issue #148: which
 * combination of emulated and launch-flag device scale factor actually enlarges
 * screencast frames.
 *
 * Usage:
 *   make screencast-bench
 *   bun scripts/bench/screencast-codec.ts --seconds 4 --url https://en.wikipedia.org/wiki/Web_browser
 *   bun scripts/bench/screencast-codec.ts --force-dsf 2     # 2x frames (Chrome launch flag)
 *   bun scripts/bench/screencast-codec.ts --delta 10        # slower scroll (CSS px per wheel event)
 *   bun scripts/bench/screencast-codec.ts --mbps 8,16,24    # bitrate targets for the video rows
 *   bun scripts/bench/screencast-codec.ts --dsf-probe
 *
 * Results also land in bench/screencast/results.json.
 */

import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp } from '../lib/cdp.ts';
import { findChrome } from '../lib/chrome.ts';

const REPO = new URL('../../', import.meta.url).pathname;
const OUT_DIR = `${REPO}bench/screencast`;

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};

const SECONDS = Number(opt('seconds', '4'));
const URL_ARG = opt('url', '');
const FORCE_DSF = Number(opt('force-dsf', '0'));
/** CSS px per wheel event, one every ~16 ms. 30 is a brisk trackpad fling (~1900 px/s). */
const DELTA = Number(opt('delta', '30'));
/** Bitrate targets tried for every video codec. */
const MBPS = opt('mbps', '2,4,8').split(',').map(Number);
const WIDTH = 1280;
const HEIGHT = 800;

// ── pages served to the bench Chrome ────────────────────────────────────

/** Text-dense and reproducible: prose, tables and gradients, no network. */
function articlePage(): string {
  const para = (i: number) =>
    `<p>${i}. ${'The screencast path streams every repaint as an independent JPEG, so a scroll that moves the whole page by a few pixels re-sends the entire viewport. '.repeat(3)}</p>`;
  const table = Array.from(
    { length: 6 },
    (_, r) =>
      `<tr>${Array.from({ length: 5 }, (_, c) => `<td>r${r}c${c} ${(r * 37 + c * 11) % 97}</td>`).join('')}</tr>`,
  ).join('');
  const sections = Array.from(
    { length: 60 },
    (_, s) =>
      `<h2>Section ${s}</h2>${para(s * 3)}${s % 4 === 0 ? '<div class=card></div>' : ''}` +
      `${para(s * 3 + 1)}${s % 5 === 0 ? `<table>${table}</table>` : ''}${para(s * 3 + 2)}`,
  ).join('');
  return `<!doctype html><meta charset=utf-8><title>article</title>
<style>body{font:16px/1.55 -apple-system,Helvetica,Arial,sans-serif;max-width:880px;margin:24px auto;color:#222}
h2{margin-top:32px}.card{height:180px;border-radius:12px;margin:16px 0;background:linear-gradient(135deg,#6a8dff,#ff8a65)}
table{border-collapse:collapse;width:100%}td{border:1px solid #ccc;padding:4px 8px;font-size:13px}</style>${sections}`;
}

/**
 * The encoder page. Served from localhost, because WebCodecs needs a secure context.
 * Everything that touches pixels runs here; the harness only ships frames and reads
 * the summary back.
 */
const ENCODER_PAGE = `<!doctype html><meta charset=utf-8><title>encoder</title><script>
async function loadFrames(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await createImageBitmap(await (await fetch('/frame/' + i)).blob()));
  return out;
}
function luma(d) {
  const y = new Float32Array(d.length / 4);
  for (let i = 0, j = 0; i < y.length; i++, j += 4) y[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  return y;
}
function psnr(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  const mse = s / a.length;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}
function summarize(label, w, h, bytes, encFps, ps, lat) {
  ps.sort((x, y) => x - y); lat.sort((x, y) => x - y);
  return { label, supported: true, w, h, bytes, encFps,
    psnrMean: ps.reduce((s, x) => s + x, 0) / ps.length, psnrMin: ps[0],
    latP50: lat.length ? lat[Math.floor(lat.length / 2)] : null,
    latP95: lat.length ? lat[Math.floor(lat.length * 0.95)] : null };
}
async function jpegRun(frames, cfg) {
  const w = frames[0].width, h = frames[0].height;
  const cx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  let bytes = 0; const ps = []; const t0 = performance.now();
  for (let i = 0; i < frames.length; i++) {
    cx.drawImage(frames[i], 0, 0);
    const blob = await cx.canvas.convertToBlob({ type: 'image/jpeg', quality: cfg.jpegQuality });
    bytes += blob.size;
    if (i % 5 === 0) {
      const ref = luma(cx.getImageData(0, 0, w, h).data);
      const bm = await createImageBitmap(blob); cx.drawImage(bm, 0, 0); bm.close();
      ps.push(psnr(ref, luma(cx.getImageData(0, 0, w, h).data)));
    }
  }
  return summarize(cfg.label, w, h, bytes, frames.length / ((performance.now() - t0) / 1000), ps, []);
}
async function videoRun(frames, ts, cfg) {
  const w = frames[0].width, h = frames[0].height;
  const config = { ...cfg.config, width: w, height: h };
  if (!(await VideoEncoder.isConfigSupported(config)).supported) return { label: cfg.label, supported: false };
  const chunks = []; const sentAt = new Map(); const lat = []; let decoderConfig;
  const enc = new VideoEncoder({
    output: (c, meta) => {
      const data = new Uint8Array(c.byteLength); c.copyTo(data);
      chunks.push({ type: c.type, timestamp: c.timestamp, data });
      if (meta && meta.decoderConfig) decoderConfig = meta.decoderConfig;
      const t = sentAt.get(c.timestamp); if (t !== undefined) lat.push(performance.now() - t);
    },
    error: (e) => { throw e; },
  });
  enc.configure(config);
  const t0 = performance.now();
  for (let i = 0; i < frames.length; i++) {
    if (cfg.paced) {
      const wait = t0 + ts[i] * 1000 - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    } else {
      while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 0));
    }
    const vf = new VideoFrame(frames[i], { timestamp: Math.round(ts[i] * 1e6) });
    sentAt.set(vf.timestamp, performance.now());
    enc.encode(vf, { keyFrame: i === 0 });
    vf.close();
  }
  await enc.flush();
  const encFps = frames.length / ((performance.now() - t0) / 1000);
  enc.close();
  // Decode back, then PSNR every 5th frame against the reference it was encoded from.
  const decoded = new Map();
  const dec = new VideoDecoder({ output: (f) => decoded.set(f.timestamp, f), error: (e) => { throw e; } });
  dec.configure(decoderConfig);
  for (const c of chunks) dec.decode(new EncodedVideoChunk(c));
  await dec.flush(); dec.close();
  const cx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  const ps = [];
  for (let i = 0; i < frames.length; i += 5) {
    const f = decoded.get(Math.round(ts[i] * 1e6)); if (!f) continue;
    cx.drawImage(frames[i], 0, 0); const ref = luma(cx.getImageData(0, 0, w, h).data);
    cx.drawImage(f, 0, 0, w, h); ps.push(psnr(ref, luma(cx.getImageData(0, 0, w, h).data)));
  }
  for (const f of decoded.values()) f.close();
  const bytes = chunks.reduce((s, c) => s + c.data.length, 0);
  return summarize(cfg.label, w, h, bytes, encFps, ps, lat);
}
window.runBench = async (n, ts, cfg) => {
  const frames = await loadFrames(n);
  try { return cfg.jpegQuality ? await jpegRun(frames, cfg) : await videoRun(frames, ts, cfg); }
  finally { for (const b of frames) b.close(); }
};
</script>`;

let frameStore: Buffer[] = [];
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const path = new URL(req.url).pathname;
    const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
    if (path === '/article') return html(articlePage());
    if (path === '/encoder') return html(ENCODER_PAGE);
    if (path === '/probe') return html(`<h1>probe</h1><p>${'text '.repeat(500)}</p>`);
    const m = path.match(/^\/frame\/(\d+)$/);
    const frame = m ? frameStore[Number(m[1])] : undefined;
    if (frame)
      return new Response(new Uint8Array(frame), { headers: { 'content-type': 'image/png' } });
    return new Response('not found', { status: 404 });
  },
});
const BASE = `http://localhost:${server.port}`;

// ── Chrome ───────────────────────────────────────────────────────────────

async function launchChrome(forceDsf: number): Promise<{ port: number; stop: () => void }> {
  const bin = findChrome();
  if (!bin) throw new Error('No Chrome found (set CHROME_PATH)');
  const profile = mkdtempSync(join(tmpdir(), 'yaar-screencast-bench-'));
  const proc = Bun.spawn(
    [
      bin,
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-extensions',
      '--disable-component-update',
      '--window-position=-2400,-2400',
      ...(forceDsf ? [`--force-device-scale-factor=${forceDsf}`] : []),
      'about:blank',
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  );
  const reader = proc.stderr.getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error('Chrome exited before DevTools came up');
    buf += new TextDecoder().decode(value);
    const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (m) {
      reader.releaseLock();
      return {
        port: Number(m[1]),
        stop: () => {
          proc.kill();
          rmSync(profile, { recursive: true, force: true });
        },
      };
    }
  }
}

/** A tab at the bench viewport, on `url`, frontmost (only the frontmost tab screencasts). */
async function openViewport(port: number, url: string, emulatedDsf: number): Promise<Cdp> {
  const page = await Cdp.openPage(port, 'about:blank');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: emulatedDsf,
    mobile: false,
  });
  const loaded = new Promise((r) => page.on('Page.loadEventFired', r));
  await page.send('Page.navigate', { url });
  await Promise.race([loaded, Bun.sleep(15_000)]);
  await Bun.sleep(1_000);
  await page.send('Page.bringToFront');
  return page;
}

// ── --dsf-probe ──────────────────────────────────────────────────────────

async function dsfProbe(): Promise<void> {
  const cases = [
    { force: 0, emulated: 1, maxWidth: 0 },
    { force: 0, emulated: 2, maxWidth: 0 },
    { force: 0, emulated: 2, maxWidth: 4096 },
    { force: 2, emulated: 2, maxWidth: 0 },
    { force: 2, emulated: 1, maxWidth: 0 },
  ];
  console.log(
    '| launch flag | emulated DSF | maxWidth | page DPR | screenshot | screencast frame | frame metadata |',
  );
  console.log('|---|---|---|---|---|---|---|');
  for (const c of cases) {
    const chrome = await launchChrome(c.force);
    try {
      const page = await openViewport(chrome.port, `${BASE}/probe`, c.emulated);
      const first = new Promise<any>((res) =>
        page.on('Page.screencastFrame', (p) => {
          page.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
          res(p);
        }),
      );
      await page.send('Page.startScreencast', {
        format: 'png',
        ...(c.maxWidth ? { maxWidth: c.maxWidth, maxHeight: c.maxWidth } : {}),
      });
      const frame = await Promise.race([first, Bun.sleep(5_000).then(() => null)]);
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      const dpr = await page.evaluate<number>('devicePixelRatio');
      const size = async (b64: string) => {
        const m = await new Bun.Image(Buffer.from(b64, 'base64')).metadata();
        return `${m.width}×${m.height}`;
      };
      const meta = frame ? `${frame.metadata.deviceWidth}×${frame.metadata.deviceHeight}` : '—';
      console.log(
        `| ${c.force || '—'} | ${c.emulated} | ${c.maxWidth || '—'} | ${dpr} | ${await size(shot.data)} | ${frame ? await size(frame.data) : 'no frame'} | ${meta} |`,
      );
      page.close();
    } finally {
      chrome.stop();
    }
  }
}

// ── codec bench ──────────────────────────────────────────────────────────

interface Row {
  label: string;
  kbps: number;
  kbPerFrame: number;
  psnr?: string;
  latencyMs?: string;
  encFps?: number;
}

function videoConfig(label: string, codec: string, mbps: number, extra: object, paced = true) {
  return {
    label,
    paced,
    config: {
      codec,
      bitrate: mbps * 1e6,
      framerate: 60,
      latencyMode: 'realtime',
      ...extra,
    },
  };
}

const h264 = (hw: boolean, mbps: number, paced = true) =>
  videoConfig(
    `H.264 ${hw ? 'HW' : 'SW'} ${mbps} Mbps${paced ? '' : ' (unpaced throughput)'}`,
    'avc1.640034',
    mbps,
    {
      hardwareAcceleration: hw ? 'prefer-hardware' : 'prefer-software',
      bitrateMode: hw ? 'variable' : 'constant',
      avc: { format: 'annexb' },
    },
    paced,
  );

const CONFIGS = [
  { label: 'JPEG q80 (high preset)', jpegQuality: 0.8 },
  { label: 'JPEG q45 (medium preset)', jpegQuality: 0.45 },
  // Discarded: the first hardware session pays encoder start-up, which once read as a
  // 0.5–1.3 s latency spike on whichever configuration happened to run first.
  { ...h264(true, MBPS[0]!), warmup: true },
  ...MBPS.map((m) => h264(true, m)),
  {
    ...h264(true, MBPS.at(-1)!),
    label: `H.264 HW ${MBPS.at(-1)} Mbps, latencyMode quality`,
    config: { ...h264(true, MBPS.at(-1)!).config, latencyMode: 'quality' },
  },
  ...MBPS.map((m) => h264(false, m)),
  ...MBPS.map((m) =>
    videoConfig(`VP9 SW ${m} Mbps`, 'vp09.00.51.08', m, {
      hardwareAcceleration: 'prefer-software',
    }),
  ),
  // Linux Chrome encodes in hardware only through VAAPI, which NVIDIA does not offer,
  // so on such a server the software codecs are the whole field.
  ...MBPS.map((m) =>
    videoConfig(`AV1 SW ${m} Mbps`, 'av01.0.08M.08', m, {
      hardwareAcceleration: 'prefer-software',
    }),
  ),
  ...MBPS.map((m) =>
    videoConfig(`AV1 SW ${m} Mbps, contentHint text`, 'av01.0.08M.08', m, {
      hardwareAcceleration: 'prefer-software',
      contentHint: 'text',
    }),
  ),
  ...MBPS.map((m) =>
    videoConfig(`VP9 SW ${m} Mbps, contentHint text`, 'vp09.00.51.08', m, {
      hardwareAcceleration: 'prefer-software',
      contentHint: 'text',
    }),
  ),
  h264(true, MBPS[Math.floor(MBPS.length / 2)]!, false),
];

async function codecBench(): Promise<void> {
  const emulatedDsf = FORCE_DSF || 1;
  const chrome = await launchChrome(FORCE_DSF);
  const rows: Row[] = [];
  let summary = '';
  try {
    const page = await openViewport(chrome.port, URL_ARG || `${BASE}/article`, emulatedDsf);
    const frames: { data: Buffer; ts: number }[] = [];
    let recording = false;
    page.on('Page.screencastFrame', (p) => {
      page.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      if (recording) frames.push({ data: Buffer.from(p.data, 'base64'), ts: p.metadata.timestamp });
    });
    await page.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    await Bun.sleep(500);
    recording = true;
    // Trackpad-like: a small wheel delta every ~16 ms, down for half the run, then back up.
    const steps = Math.round((SECONDS * 1000) / 16);
    for (let i = 0; i < steps; i++) {
      const deltaY = i < steps / 2 ? DELTA : -DELTA;
      page
        .send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY })
        .catch(() => {});
      await Bun.sleep(16);
    }
    await Bun.sleep(300);
    recording = false;
    await page.send('Page.stopScreencast');
    page.close();
    if (frames.length < 2) throw new Error(`Recorded ${frames.length} frames; nothing to encode`);

    const duration = frames.at(-1)!.ts - frames[0]!.ts;
    const pngBytes = frames.reduce((s, f) => s + f.data.length, 0);
    const size = await new Bun.Image(frames[0]!.data).metadata();
    summary =
      `${frames.length} frames over ${duration.toFixed(2)} s (${(frames.length / duration).toFixed(1)} fps), ` +
      `${size.width}×${size.height}, launch DSF ${FORCE_DSF || 'default'}, emulated DSF ${emulatedDsf}, ` +
      `scroll ${DELTA} CSS px per wheel event`;
    console.error(summary);
    const kbps = (bytes: number) => Math.round((bytes * 8) / duration / 1000);
    rows.push({
      label: 'PNG screencast (reference)',
      kbps: kbps(pngBytes),
      kbPerFrame: pngBytes / frames.length / 1024,
    });

    frameStore = frames.map((f) => f.data);
    const ts = frames.map((f) => f.ts - frames[0]!.ts);
    const encoder = await Cdp.openPage(chrome.port, `${BASE}/encoder`);
    await encoder.waitFor('typeof window.runBench === "function"');
    for (const cfg of CONFIGS) {
      try {
        const r = await encoder.evaluate<any>(
          `runBench(${frames.length}, ${JSON.stringify(ts)}, ${JSON.stringify(cfg)})`,
        );
        if ('warmup' in cfg) continue;
        if (!r.supported) {
          console.error(`${cfg.label}: unsupported`);
          continue;
        }
        rows.push({
          label: cfg.label,
          kbps: kbps(r.bytes),
          kbPerFrame: r.bytes / frames.length / 1024,
          psnr: `${r.psnrMean.toFixed(1)} (${r.psnrMin.toFixed(1)})`,
          latencyMs: r.latP50 === null ? '—' : `${r.latP50.toFixed(1)} / ${r.latP95.toFixed(1)}`,
          encFps: Math.round(r.encFps),
        });
        console.error(`${cfg.label}: done`);
      } catch (err) {
        console.error(`${cfg.label}: ${(err as Error).message.slice(0, 200)}`);
      }
    }
    encoder.close();
  } finally {
    chrome.stop();
  }

  console.log(`\n${summary}\n`);
  console.log('| stream | kbps | KB/frame | PSNR mean (min) | latency p50 / p95 ms | enc fps |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(
      `| ${r.label} | ${r.kbps} | ${r.kbPerFrame.toFixed(1)} | ${r.psnr ?? 'ref'} | ${r.latencyMs ?? '—'} | ${r.encFps ?? '—'} |`,
    );
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/results.json`, JSON.stringify({ summary, rows }, null, 2));
}

try {
  await (flag('dsf-probe') ? dsfProbe() : codecBench());
} finally {
  server.stop(true);
}
