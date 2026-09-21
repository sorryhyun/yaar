/**
 * Put the dev Chrome into phone mode, from the outside, over CDP.
 *
 * `make claude-dev-mobile` is for testing the phone shell on a PC, and a narrow window is
 * only half of that. The phone shell's gestures — the monitor pan, the palette pull-up,
 * the notification shade — are `touchstart`/`touchmove`/`touchend`, and a desktop mouse
 * emits none of those. Neither does `--touch-events=enabled`, which only makes the page
 * *believe* a touchscreen exists. The switch that turns a drag of the mouse into a real
 * touch stream is DevTools device mode, and DevTools device mode is these two CDP calls:
 *
 * - `Emulation.setTouchEmulationEnabled` — the page gets `maxTouchPoints` and the touch
 *   event constructors.
 * - `Emulation.setEmitTouchEventsForMouse` with `configuration: 'mobile'` — the mouse
 *   starts emitting them, and the primary pointer becomes coarse.
 *
 * That second half is why nothing here pins `?ui=mobile`. A coarse pointer in a narrow
 * window is exactly what `MOBILE_MEDIA_QUERY` asks for, so the shell reaches the phone
 * layout the way a phone does — which makes the layout itself the signal that the
 * emulation landed. Pinned, a failure here would look like a phone that ignores fingers.
 *
 * Emulation overrides belong to the DevTools client that set them and are dropped when it
 * disconnects, so this process stays attached until it is killed. `start.sh` owns it and
 * reaps it in `cleanup`.
 *
 * ## Backgrounding the phone
 *
 * A phone's other half is that it leaves: switch apps and Android hides the tab, then
 * freezes it, while its WebSocket stays up (see the server's `session/client-presence.ts`).
 * That is the state the app-window responder pinning and the companion tab exist for, and
 * a PC window never enters it on its own. So this process also serves a small control
 * endpoint on loopback:
 *
 * - `POST /background` — minimize the phone window (the page reports `hidden`), then after
 *   `YAAR_MOBILE_FREEZE_MS` (default 3000, `0` = never) freeze it with
 *   `Page.setWebLifecycleState`, which is what a real backgrounded Android tab reaches.
 * - `POST /foreground` — resume, restore the window, refit the viewport.
 * - `GET /` — what each attached page is doing.
 *
 * Port `YAAR_MOBILE_CONTROL_PORT` (default 9231), e.g.
 * `curl -X POST localhost:9231/background`.
 */

/** The viewport to emulate. Pixel-7 shaped; override with YAAR_MOBILE_VIEWPORT=WxH. */
const DEFAULT_VIEWPORT = { width: 412, height: 915 };

/** Loopback port of the background/foreground control endpoint. */
const CONTROL_PORT = Number(process.env.YAAR_MOBILE_CONTROL_PORT ?? 9231);

/** How long after hiding the phone window it is frozen; 0 leaves it merely hidden. */
const FREEZE_MS = Number(process.env.YAAR_MOBILE_FREEZE_MS ?? 3000);

/** How often to look for a page that is not in phone mode yet. */
const POLL_MS = 1000;

/**
 * Give up after this many consecutive unreachable polls *once Chrome has been seen*.
 *
 * Before the first sighting there is no timeout at all: this process starts alongside the
 * server and Chrome only opens once the server answers, which can be a minute. After it,
 * an unreachable port means the browser is gone, and a launcher helper that outlives its
 * browser is the kind of process that accumulates one per run. `start.sh` kills this on
 * the way out; this is what covers the ways out it does not see.
 */
const GONE_AFTER_POLLS = 10;

function parseViewport(raw: string | undefined): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(raw?.trim() ?? '');
  if (!match) return DEFAULT_VIEWPORT;
  return { width: Number(match[1]), height: Number(match[2]) };
}

interface Target {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/**
 * One CDP connection, reduced to the one thing this script does with it: send a command
 * and wait for its answer. Not `lib/browser/cdp.ts` — that client is server plumbing with
 * a `ws` dependency and a session store behind it, and reaching into the server package
 * from a launcher script would buy nothing a promise map does not.
 */
class Connection {
  private nextId = 1;
  private pending = new Map<number, (result: { result?: unknown; error?: unknown }) => void>();

  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: unknown;
      };
      if (typeof message.id !== 'number') return;
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
    });
  }

  static connect(url: string): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Connection(ws)));
      ws.addEventListener('error', () => reject(new Error(`CDP connect failed: ${url}`)));
    });
  }

  onClose(handler: () => void): void {
    this.ws.addEventListener('close', handler);
  }

  send<T = Record<string, unknown>>(method: string, params: unknown = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (message) => {
        if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
        else resolve((message.result ?? {}) as T);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

/**
 * Size the window so that the *page* is the requested size.
 *
 * `Browser.setWindowBounds` sets the outer window, which includes a title bar whose height
 * nobody here knows — it differs per platform and per window type. So: set it, ask the
 * page how big it actually came out, and correct by the difference. One pass is enough,
 * because the difference is a constant.
 */
async function fitViewport(
  cdp: Connection,
  targetId: string,
  viewport: { width: number; height: number },
): Promise<{ width: number; height: number }> {
  const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', {
    targetId,
  });
  const setBounds = (width: number, height: number) =>
    cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { width, height, windowState: 'normal' },
    });
  const measure = async () => {
    const { result } = await cdp.send<{ result: { value: { width: number; height: number } } }>(
      'Runtime.evaluate',
      {
        expression: '({ width: innerWidth, height: innerHeight })',
        returnByValue: true,
      },
    );
    return result.value;
  };

  await setBounds(viewport.width, viewport.height);
  const actual = await measure();
  await setBounds(
    viewport.width + (viewport.width - actual.width),
    viewport.height + (viewport.height - actual.height),
  );
  return measure();
}

async function makePhone(target: Target, viewport: { width: number; height: number }) {
  const cdp = await Connection.connect(target.webSocketDebuggerUrl!);

  // Both, and neither fatal. setEmitTouchEventsForMouse is the deprecated half of a pair
  // Chrome has been merging for a while: on a newer build setTouchEmulationEnabled already
  // does the mouse conversion and this second call is a no-op, on an older one it is the
  // only call that does it. Sending both is how one script covers both.
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp
    .send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' })
    .catch(() => {
      /* merged into setTouchEmulationEnabled on this build */
    });

  const actual = await fitViewport(cdp, target.id, viewport);
  console.log(`[mobile] ${target.url} → ${actual.width}×${actual.height}, mouse drags are touches`);
  return cdp;
}

interface Phone {
  cdp: Connection;
  target: Target;
  state: 'foreground' | 'hidden' | 'frozen';
  freezeTimer: ReturnType<typeof setTimeout> | null;
}

async function setWindowState(phone: Phone, windowState: 'minimized' | 'normal') {
  const { windowId } = await phone.cdp.send<{ windowId: number }>('Browser.getWindowForTarget', {
    targetId: phone.target.id,
  });
  await phone.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState } });
}

/** Hide, then freeze — the order a real Android tab goes through when the user switches apps. */
async function background(phone: Phone): Promise<void> {
  if (phone.state !== 'foreground') return;
  await setWindowState(phone, 'minimized');
  phone.state = 'hidden';
  if (FREEZE_MS > 0) {
    phone.freezeTimer = setTimeout(() => {
      phone.freezeTimer = null;
      if (phone.state !== 'hidden') return;
      phone.cdp
        .send('Page.setWebLifecycleState', { state: 'frozen' })
        .then(() => {
          phone.state = 'frozen';
          console.log(`[mobile] ${phone.target.url} frozen`);
        })
        .catch((error) => console.warn('[mobile] freeze failed:', error));
    }, FREEZE_MS);
  }
}

async function foreground(phone: Phone, viewport: { width: number; height: number }) {
  if (phone.freezeTimer) clearTimeout(phone.freezeTimer);
  phone.freezeTimer = null;
  if (phone.state === 'frozen') {
    await phone.cdp.send('Page.setWebLifecycleState', { state: 'active' });
  }
  if (phone.state !== 'foreground') {
    await setWindowState(phone, 'normal');
    await fitViewport(phone.cdp, phone.target.id, viewport);
  }
  phone.state = 'foreground';
}

function serveControl(phones: Map<string, Phone>, viewport: { width: number; height: number }) {
  const summary = () => [...phones.values()].map((p) => ({ url: p.target.url, state: p.state }));
  try {
    Bun.serve({
      hostname: '127.0.0.1',
      port: CONTROL_PORT,
      async fetch(req) {
        const { pathname } = new URL(req.url);
        const act =
          req.method === 'POST' && pathname === '/background'
            ? background
            : req.method === 'POST' && pathname === '/foreground'
              ? (p: Phone) => foreground(p, viewport)
              : null;
        if (act) {
          const results = await Promise.allSettled([...phones.values()].map((p) => act(p)));
          const failed = results.filter((r) => r.status === 'rejected');
          for (const f of failed) console.warn('[mobile]', (f as PromiseRejectedResult).reason);
          console.log(`[mobile] ${pathname.slice(1)}: ${phones.size} page(s)`);
          return Response.json({ ok: failed.length === 0, pages: summary() });
        }
        if (req.method === 'GET' && pathname === '/') return Response.json({ pages: summary() });
        return new Response('POST /background, POST /foreground, GET /\n', { status: 404 });
      },
    });
    console.log(
      `[mobile] Background the phone: curl -X POST localhost:${CONTROL_PORT}/background ` +
        `(frozen after ${FREEZE_MS}ms); back: .../foreground`,
    );
  } catch (error) {
    console.warn(`[mobile] control endpoint not started on :${CONTROL_PORT}:`, error);
  }
}

async function main() {
  const port = Number(process.env.CHROME_DEBUG_PORT ?? 9222);
  const viewport = parseViewport(process.env.YAAR_MOBILE_VIEWPORT);

  // targetId → the connection holding its overrides. The entry is dropped when the
  // connection closes (tab closed, Chrome quit), so the next poll re-adopts a page that
  // came back.
  const attached = new Map<string, Phone>();
  serveControl(attached, viewport);
  let announced = false;
  let misses = 0;

  for (;;) {
    let targets: Target[] = [];
    try {
      targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())) as
        | Target[]
        | never;
      misses = 0;
      if (!announced) {
        console.log(`[mobile] Attached to Chrome on port ${port}`);
        announced = true;
      }
    } catch {
      // Chrome is not up yet, or is on its way down — and which one it is depends on
      // whether we ever saw it.
      if (announced && ++misses >= GONE_AFTER_POLLS) {
        console.log('[mobile] Chrome is gone — nothing left to keep in phone mode');
        return;
      }
    }

    for (const target of targets) {
      // Only real pages: devtools://, chrome:// and the extension targets have nothing to
      // emulate and would each cost a connection.
      if (target.type !== 'page' || !/^https?:/.test(target.url)) continue;
      if (attached.has(target.id) || !target.webSocketDebuggerUrl) continue;
      try {
        const cdp = await makePhone(target, viewport);
        attached.set(target.id, { cdp, target, state: 'foreground', freezeTimer: null });
        cdp.onClose(() => attached.delete(target.id));
      } catch (error) {
        console.warn(`[mobile] Could not put ${target.url} into phone mode:`, error);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

await main();
