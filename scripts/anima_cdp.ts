// Headless WebGPU driver for the Anima app — reproduce the browser DiT/VAE run
// from the CLI, no Claude-in-Chrome clicking.
//
//   bun scripts/anima_cdp.ts caps
//   bun scripts/anima_cdp.ts probe
//   bun scripts/anima_cdp.ts generate dit_512_fp16_webgpu 0
//   bun scripts/anima_cdp.ts generate dit_512_fp16_webgpu 0 --headful
//
// Launches system Chrome (--headless=new + --enable-unsafe-webgpu) against a
// persistent profile so the app's IndexedDB weight-graph cache survives runs,
// connects to the page target via CDP, calls window.__anima.<op>(), prints the
// JSON result, and saves any returned image dataURL to scratchpad/anima_out.png.

const APP_URL = 'http://127.0.0.1:8000/api/apps/anima/dist/index.html';
const SCRATCH = process.env.ANIMA_SCRATCH || '/tmp/anima-cdp';
const PROFILE = `${SCRATCH}/chrome-profile`;

const op = process.argv[2] || 'caps';
const rest = process.argv.slice(3).filter((a) => !a.startsWith('--'));
const headful = process.argv.includes('--headful');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const argJson =
  op === 'generate'
    ? JSON.stringify({
        model: rest[0] || 'dit_512_fp16_webgpu',
        seed: Number(rest[1] ?? 0),
        ditBackend: (rest[2] as 'webgpu' | 'wasm') || 'webgpu',
      })
    : '';

function sh(cmd: string[], opts: Record<string, unknown> = {}) {
  return Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', ...opts });
}

async function getJson(url: string) {
  const r = await fetch(url);
  return r.json();
}

// ── minimal CDP client over Bun's native WebSocket ───────────────────────────
class CDP {
  ws: WebSocket;
  id = 1;
  pending = new Map<number, (v: any) => void>();
  static async connect(url: string): Promise<CDP> {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', () => res(null), { once: true });
      ws.addEventListener('error', (e) => rej(e), { once: true });
    });
    return new CDP(ws);
  }
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data as string);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      }
    });
  }
  send(method: string, params: any = {}): Promise<any> {
    const id = this.id++;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression: string, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (r.error) throw new Error('CDP eval: ' + JSON.stringify(r.error));
    const res = r.result?.result;
    if (r.result?.exceptionDetails)
      throw new Error('page exception: ' + JSON.stringify(r.result.exceptionDetails));
    return res?.value;
  }
}

const flags = [
  headful ? '' : '--headless=new',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan,WebGPU',
  '--use-angle=metal',
  `--remote-debugging-port=9333`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  APP_URL,
].filter(Boolean);

console.error(`[cdp] launching Chrome (${headful ? 'headful' : 'headless'})…`);
const proc = sh([CHROME, ...flags]);

// wait for the debugging endpoint, find the app page target
let pageWs = '';
for (let i = 0; i < 60; i++) {
  try {
    const list = (await getJson('http://127.0.0.1:9333/json/list')) as any[];
    const page = list.find((t) => t.type === 'page' && t.url.includes('/api/apps/anima/'));
    if (page?.webSocketDebuggerUrl) {
      pageWs = page.webSocketDebuggerUrl;
      break;
    }
  } catch {
    /* not up yet */
  }
  await Bun.sleep(500);
}
if (!pageWs) {
  console.error('[cdp] could not find app page target');
  proc.kill();
  process.exit(1);
}

const cdp = await CDP.connect(pageWs);
await cdp.send('Runtime.enable');

// wait for the app to boot and expose window.__anima
let ready = false;
for (let i = 0; i < 60; i++) {
  const r = await cdp.eval('!!(window.__anima && window.__anima.ready)');
  if (r === true) {
    ready = true;
    break;
  }
  await Bun.sleep(500);
}
if (!ready) {
  console.error('[cdp] window.__anima never became ready');
  proc.kill();
  process.exit(1);
}
console.error('[cdp] app ready — running:', op, argJson);

try {
  const probeArg = rest[0]
    ? JSON.stringify({ model: rest[0], dataName: rest[1] })
    : '';
  const expr =
    op === 'caps'
      ? 'window.__anima.caps()'
      : op === 'probe'
        ? `window.__anima.probe(${probeArg})`
        : op === 'clear'
          ? 'window.__anima.clearCache().then(()=>({cleared:true}))'
          : `window.__anima.generate(${argJson})`;
  const t0 = Date.now();
  const result = await cdp.eval(expr, true);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  // save image if present
  if (result && typeof result === 'object' && (result as any).dataUrl) {
    const b64 = (result as any).dataUrl.split(',')[1];
    await Bun.write(`${SCRATCH}/anima_out.png`, Buffer.from(b64, 'base64'));
    (result as any).dataUrl = `<saved ${SCRATCH}/anima_out.png>`;
  }
  console.error(`[cdp] done in ${secs}s`);
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error('[cdp] error:', e instanceof Error ? e.message : String(e));
} finally {
  cdp.ws.close();
  proc.kill();
}
