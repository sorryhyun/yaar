/**
 * Minimal Chrome DevTools Protocol client over WebSocket — just enough to drive
 * a headless Chrome for the benchmarks (scripts/bench/claude.ts, mobile.ts,
 * screencast-codec.ts): attach to or open a page target, evaluate JS in it, wait for
 * readiness, send raw commands (Input.dispatchTouchEvent, Emulation.*,
 * Performance.getMetrics), and listen for events (Page.screencastFrame).
 *
 * No dependency on puppeteer or the server's internal browser lib — a benchmark
 * harness should stay self-contained.
 */

type CdpTarget = { id: string; type: string; url: string; webSocketDebuggerUrl: string };

export class Cdp {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private listeners = new Map<string, ((params: any) => void)[]>();

  private constructor() {}

  /** Poll the CDP HTTP endpoint until a page target for `urlIncludes` appears, then attach. */
  static async attachToPage(
    debugPort: number,
    urlIncludes: string,
    timeoutMs = 30_000,
  ): Promise<Cdp> {
    const deadline = Date.now() + timeoutMs;
    let target: CdpTarget | undefined;
    while (Date.now() < deadline) {
      try {
        const list = (await fetch(`http://127.0.0.1:${debugPort}/json`).then((r) =>
          r.json(),
        )) as CdpTarget[];
        target = list.find((t) => t.type === 'page' && t.url.includes(urlIncludes));
        if (target?.webSocketDebuggerUrl) break;
      } catch {
        /* Chrome not up yet */
      }
      await Bun.sleep(300);
    }
    if (!target?.webSocketDebuggerUrl) {
      throw new Error(`No CDP page target for "${urlIncludes}" on port ${debugPort}`);
    }
    return Cdp.open(target.webSocketDebuggerUrl);
  }

  /** Open a new tab on `url` and attach to it. */
  static async openPage(debugPort: number, url: string): Promise<Cdp> {
    const target = (await fetch(`http://127.0.0.1:${debugPort}/json/new?${url}`, {
      method: 'PUT',
    }).then((r) => r.json())) as CdpTarget;
    return Cdp.open(target.webSocketDebuggerUrl);
  }

  private static async open(wsUrl: string): Promise<Cdp> {
    const c = new Cdp();
    c.ws = new WebSocket(wsUrl);
    c.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data as string);
      if (msg.id && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id)!;
        c.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of c.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
    await new Promise<void>((res, rej) => {
      c.ws.addEventListener('open', () => res(), { once: true });
      c.ws.addEventListener('error', () => rej(new Error('CDP socket error')), { once: true });
    });
    await c.send('Runtime.enable');
    await c.send('Page.enable');
    return c;
  }

  /** Subscribe to a CDP event on the page session. */
  on(method: string, fn: (params: any) => void): void {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), fn]);
  }

  /** A raw CDP command on the page session. */
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an expression in the page. Returns the (JSON-serialized) value. */
  async evaluate<T = any>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`page eval failed: ${r.exceptionDetails.text} — ${expression.slice(0, 80)}`);
    }
    return r.result?.value as T;
  }

  /** Poll `expression` (must return boolean) until true or timeout. */
  async waitFor(expression: string, timeoutMs = 20_000, pollMs = 250): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(`!!(${expression})`)) return true;
      await Bun.sleep(pollMs);
    }
    return false;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
