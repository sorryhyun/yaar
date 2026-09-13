/**
 * The socket half of the bypass: an HTTP CONNECT proxy on loopback.
 *
 * The decisions live in `policy.ts` and `split.ts`; what is here is the plumbing that
 * makes them work on a real connection, and three details that are easy to get wrong:
 *
 *   - **Corking.** Bun batches writes issued inside a socket handler and flushes once.
 *     Two back-to-back `write()` calls therefore leave as *one* segment, which is
 *     exactly the thing fragmentation exists to prevent — so each fragment is followed
 *     by an explicit `flush()`.
 *   - **Nagle.** Without `setNoDelay(true)` the kernel may coalesce the fragments back
 *     together regardless of how carefully they were written.
 *   - **Short writes.** `Socket.write()` returns a byte count, not a boolean. Ignoring
 *     it corrupts a tunnel under load instead of failing loudly, so every write goes
 *     through `push()` and the remainder is finished on `drain`.
 */

import { connect, listen, type Socket, type TCPSocketListener } from 'bun';
import { canReplay, escalate, HostPolicy } from './policy.js';
import { DohResolver, refusalForAddress, type Resolver } from './resolve.js';
import { planSplit, recordsFor, segmentsFor } from './split.js';
import type { FreeDpiConfig, FreeDpiProxy, Outcome, Route } from './types.js';

const TAG = '[FreeDPI]';

/** Measured against SK Broadband (AS9318); see `FreeDpiConfig.stallMs`. */
const DEFAULT_STALL_MS = 3000;

interface Backpressured {
  q: Uint8Array[];
}

interface ClientState extends Backpressured {
  phase: 'header' | 'tunnel';
  head: Uint8Array[];
  host: string;
  port: number;
  up: Socket<UpstreamState> | null;
  /** The buffered first flight, kept so a reset attempt can be replayed verbatim. */
  firstFlight: Uint8Array | null;
  /** Client bytes not yet handed upstream (dialing, or mid-stall). */
  pending: Uint8Array[];
  route: Route;
  attempts: number;
  serverBytes: number;
  sentFirstFlight: boolean;
  stalling: boolean;
  stallTimer: ReturnType<typeof setTimeout> | null;
  /** Bumped per dial; events from a superseded upstream are ignored. */
  generation: number;
  announced: boolean;
  closed: boolean;
}

interface UpstreamState extends Backpressured {
  client: Socket<ClientState>;
  generation: number;
}

/** Order-preserving write that survives a short write. */
function push(sock: Socket<Backpressured>, chunk: Uint8Array): void {
  if (chunk.length === 0) return;
  if (sock.data.q.length > 0) {
    sock.data.q.push(chunk);
    return;
  }
  const n = sock.write(chunk);
  if (n < chunk.length) sock.data.q.push(chunk.subarray(n));
}

function drain(sock: Socket<Backpressured>): void {
  const q = sock.data.q;
  while (q.length > 0) {
    const head = q[0]!;
    const n = sock.write(head);
    if (n < head.length) {
      q[0] = head.subarray(n);
      return;
    }
    q.shift();
  }
}

/** `CONNECT host:port HTTP/1.1` → the target, or null if this is not a CONNECT. */
export function parseConnect(requestLine: string): { host: string; port: number } | null {
  const m = /^CONNECT\s+(\[[^\]]+\]|[^:\s]+):(\d+)\s/.exec(`${requestLine} `);
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1]!.replace(/^\[|\]$/g, ''), port };
}

export function createFreeDpiProxy(config: FreeDpiConfig = {}): FreeDpiProxy {
  const stallMs = config.stallMs ?? DEFAULT_STALL_MS;
  const policy = new HostPolicy({ ttlMs: config.verdictTtlMs, maxHosts: config.maxHosts });
  const resolver: Resolver = new DohResolver(config.dohUrl);

  const endClient = (client: Socket<ClientState>, body?: string): void => {
    const st = client.data;
    if (st.closed) return;
    st.closed = true;
    if (st.stallTimer) clearTimeout(st.stallTimer);
    st.stallTimer = null;
    st.up?.end();
    st.up = null;
    if (body && !st.announced) client.end(body);
    else client.end();
  };

  /** Write the first flight, fragmented however this attempt's rung says. */
  const writeFirstFlight = (client: Socket<ClientState>, chunk: Uint8Array): void => {
    const st = client.data;
    const up = st.up;
    if (!up) return;

    st.firstFlight = chunk;
    st.sentFirstFlight = true;

    const segments =
      st.route === 'bypass'
        ? segmentsFor(chunk, planSplit(chunk, st.host))
        : st.route === 'tlsrec'
          ? recordsFor(chunk, st.host)
          : [chunk];

    // Only the top rung stalls; the record split relies on framing, not timing.
    if (segments.length <= 1 || st.route !== 'bypass') {
      for (const segment of segments) {
        push(up, segment);
        up.flush();
      }
      return;
    }

    push(up, segments[0]!);
    up.flush();

    // The stall is the point: a middlebox that reassembles only fails to match once
    // the remainder lands after its reassembly buffer has expired.
    st.stalling = true;
    const generation = st.generation;
    st.stallTimer = setTimeout(() => {
      st.stallTimer = null;
      st.stalling = false;
      if (st.closed || st.generation !== generation || !st.up) return;
      for (const segment of segments.slice(1)) {
        push(st.up, segment);
        st.up.flush();
      }
      flushPending(client);
    }, stallMs);
  };

  const flushPending = (client: Socket<ClientState>): void => {
    const st = client.data;
    while (!st.stalling && st.up && st.pending.length > 0) {
      const chunk = st.pending.shift()!;
      if (!st.sentFirstFlight) writeFirstFlight(client, chunk);
      else push(st.up, chunk);
    }
  };

  /** Fold the finished attempt into the table, replaying once if it looks censored. */
  const settle = (client: Socket<ClientState>, outcome: Outcome): void => {
    const st = client.data;
    if (st.closed) return;

    const replayable = canReplay({
      route: st.route,
      outcome,
      serverBytesDelivered: st.serverBytes,
      attempts: st.attempts,
      hasFirstFlight: st.firstFlight !== null,
    });

    if (!replayable) {
      policy.record(st.host, st.route, outcome);
      endClient(client);
      return;
    }

    const next = escalate(st.route)!;
    policy.record(st.host, st.route, 'reset');
    console.log(
      `${TAG} ${st.host} reset before any server byte on ${st.route} — retrying as ${next}`,
    );

    st.up = null;
    st.route = next;
    st.attempts += 1;
    st.sentFirstFlight = false;
    st.pending.unshift(st.firstFlight!);
    void dial(client);
  };

  const dial = async (client: Socket<ClientState>): Promise<void> => {
    const st = client.data;
    st.generation += 1;
    const generation = st.generation;

    let address: string;
    try {
      address = await resolver.resolve(st.host);
    } catch (err) {
      console.warn(`${TAG} could not resolve ${st.host}: ${String(err)}`);
      endClient(client, 'HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }

    // The address dialed is the one resolved here, which no earlier SSRF check has
    // seen. See resolve.ts — this is the only place that check can happen.
    const refusal = refusalForAddress(address);
    if (refusal) {
      console.warn(`${TAG} ${refusal} (requested as ${st.host})`);
      endClient(client, 'HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    if (st.closed || st.generation !== generation) return;

    try {
      await connect<UpstreamState>({
        hostname: address,
        port: st.port,
        data: { q: [], client, generation },
        socket: {
          open(up) {
            if (st.closed || st.generation !== up.data.generation) {
              up.end();
              return;
            }
            up.setNoDelay(true);
            st.up = up;
            if (!st.announced) {
              st.announced = true;
              client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
              client.flush();
            }
            flushPending(client);
          },
          data(up, chunk) {
            if (st.generation !== up.data.generation) return;
            if (st.serverBytes === 0) policy.record(st.host, st.route, 'served');
            st.serverBytes += chunk.length;
            push(client, chunk);
          },
          drain,
          close(up) {
            if (st.generation !== up.data.generation) return;
            settle(client, st.serverBytes > 0 ? 'served' : reasonForSilentClose(st));
          },
          error(up) {
            if (st.generation !== up.data.generation) return;
            settle(client, st.serverBytes > 0 ? 'served' : reasonForSilentClose(st));
          },
        },
      });
    } catch (err) {
      // Never opened: refused, unroutable, timed out. Says nothing about censorship.
      console.warn(`${TAG} could not reach ${st.host} at ${address}: ${String(err)}`);
      if (st.generation !== generation) return;
      policy.record(st.host, st.route, 'inconclusive');
      endClient(client, 'HTTP/1.1 502 Bad Gateway\r\n\r\n');
    }
  };

  /**
   * A connection that opened, carried our first flight, and died without a single
   * server byte is the shape an injected reset has. Anything else is unremarkable.
   */
  const reasonForSilentClose = (st: ClientState): Outcome =>
    st.sentFirstFlight ? 'reset' : 'inconclusive';

  const listener: TCPSocketListener<ClientState> = listen<ClientState>({
    hostname: '127.0.0.1',
    port: config.port ?? 0,
    socket: {
      open(sock) {
        sock.data = {
          q: [],
          phase: 'header',
          head: [],
          host: '',
          port: 443,
          up: null,
          firstFlight: null,
          pending: [],
          route: 'direct',
          attempts: 1,
          serverBytes: 0,
          sentFirstFlight: false,
          stalling: false,
          stallTimer: null,
          generation: 0,
          announced: false,
          closed: false,
        };
        sock.setNoDelay(true);
      },
      data(sock, chunk) {
        const st = sock.data;
        if (st.phase === 'tunnel') {
          st.pending.push(chunk);
          flushPending(sock);
          return;
        }

        st.head.push(chunk);
        const buf = Buffer.concat(st.head);
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) {
          // Bound the header so a client that never terminates it cannot grow us.
          if (buf.length > 16 * 1024) {
            endClient(sock, 'HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n');
          }
          return;
        }

        const target = parseConnect(buf.subarray(0, buf.indexOf('\r\n')).toString('latin1'));
        if (!target) {
          // Only CONNECT is served: this proxy exists to fragment a TLS first flight.
          endClient(sock, 'HTTP/1.1 405 Method Not Allowed\r\n\r\n');
          return;
        }

        st.phase = 'tunnel';
        st.head = [];
        st.host = target.host;
        st.port = target.port;
        st.route = policy.route(target.host);

        const leftover = buf.subarray(end + 4);
        if (leftover.length > 0) st.pending.push(new Uint8Array(leftover));
        void dial(sock);
      },
      drain,
      close: (sock) => endClient(sock),
      error: (sock) => endClient(sock),
    },
  });

  console.log(`${TAG} listening on 127.0.0.1:${listener.port} (stall ${stallMs}ms)`);

  return {
    port: listener.port,
    proxyUrl: `http://127.0.0.1:${listener.port}`,
    stop() {
      listener.stop(true);
      policy.clear();
    },
  };
}
