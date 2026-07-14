/**
 * Fake #1 — the browser, as a socket that can answer.
 *
 * Not a mock of the session, not a mock of routing: an in-memory `ServerWebSocket` whose
 * frames go into the *real* `createWsHandlers().message()`. That is the entire point. The
 * deadlock this harness exists to catch lived in the seam between a connection's frame
 * queue and a turn that waits for a frame on that same connection, and every test we had
 * stood on one side of it or the other. A reply delivered here travels the queue the bug
 * lived in.
 *
 * `onFrame` is what makes it a *client* rather than a recorder: it scripts a browser that
 * answers — sees an `APP_PROTOCOL_REQUEST` go out, and sends back an `APP_PROTOCOL_RESPONSE`
 * carrying the same `requestId`, on the socket the server is currently blocked on.
 */
import type { ServerWebSocket } from 'bun';
import type { ClientEvent, ServerEvent } from '@yaar/shared';
import type { WsData } from '../../../websocket/server.js';

/** The handler trio returned by `createWsHandlers`, as this file uses it. */
export interface WsHandlers {
  open(ws: ServerWebSocket<WsData>): Promise<void> | void;
  message(ws: ServerWebSocket<WsData>, data: string | Buffer): Promise<void> | void;
  close(ws: ServerWebSocket<WsData>): Promise<void> | void;
}

/** A scripted browser reaction to one outbound frame type. */
type Responder = (frame: never) => void | Promise<void>;

let nextConnection = 0;

export class FakeClient {
  /** Every frame the server sent this connection, in order. */
  readonly sent: ServerEvent[] = [];

  readonly data: WsData;
  readonly readyState = 1;

  private readonly handlers: WsHandlers;
  private readonly responders = new Map<string, Responder[]>();
  /** Responder work in flight, so `dispose()` can see it finish and surface its errors. */
  private readonly reacting = new Set<Promise<void>>();

  constructor(handlers: WsHandlers, sessionId: string | null = null, monitorId = '0') {
    this.handlers = handlers;
    this.data = {
      kind: 'frontend',
      connectionId: `harness-conn-${++nextConnection}`,
      sessionId,
      monitorId,
    };
  }

  /** The server's `ws` — same object, seen through the type the handlers expect. */
  get ws(): ServerWebSocket<WsData> {
    return this as unknown as ServerWebSocket<WsData>;
  }

  // ── Server → client ──────────────────────────────────────────────────

  /** Called by the server. Records the frame, then lets any scripted responder react. */
  send(raw: string): number {
    const event = JSON.parse(raw) as ServerEvent;
    this.sent.push(event);

    const responders = this.responders.get(event.type);
    if (responders) {
      for (const respond of responders) {
        // Off the server's stack, deliberately: `send()` is called from inside the turn
        // that is about to wait for this frame's answer. Reacting synchronously would
        // answer a question the server has not finished asking.
        const work = Promise.resolve()
          .then(() => respond(event as never))
          .finally(() => {
            this.reacting.delete(work);
          });
        this.reacting.add(work);
      }
    }
    return raw.length;
  }

  /** Frames of one type the server has sent so far. */
  framesOf<T extends ServerEvent['type']>(type: T): Extract<ServerEvent, { type: T }>[] {
    return this.sent.filter((e) => e.type === type) as Extract<ServerEvent, { type: T }>[];
  }

  /**
   * Script the browser's reaction to an outbound frame — the half of the round trip no
   * test we owned has ever had. The responder normally ends by `deliver()`ing the answer.
   */
  onFrame<T extends ServerEvent['type']>(
    type: T,
    respond: (frame: Extract<ServerEvent, { type: T }>) => void | Promise<void>,
  ): void {
    const list = this.responders.get(type) ?? [];
    list.push(respond as Responder);
    this.responders.set(type, list);
  }

  /**
   * Resolve when the server sends a frame of this type — "the server has now asked".
   *
   * A test that wants to hold an answer back needs to know the question was asked, and it
   * cannot get that from a fixed number of event-loop turns: a turn does real work before
   * it reaches its tool (a system prompt to assemble, an app profile to read off disk), so
   * "flush once and look" races the server rather than observing it. Wait for the frame.
   *
   * `match` narrows to the frame a test actually means. Two of the five server→client
   * waits (`window.capture`'s render feedback, and a user prompt) ask their question
   * inside an `ACTIONS` frame rather than a type of their own, and a session sends
   * `ACTIONS` for plenty of other reasons — so "the first ACTIONS frame" is not the
   * question, it merely often happens to be.
   */
  waitForFrame<T extends ServerEvent['type']>(
    type: T,
    match?: (frame: Extract<ServerEvent, { type: T }>) => boolean,
  ): Promise<Extract<ServerEvent, { type: T }>> {
    // `?? true` and not `|| true`: a matcher that says *no* must be believed.
    const already = this.framesOf(type).find((frame) => match?.(frame) ?? true);
    if (already) return Promise.resolve(already);
    return new Promise((resolve) => {
      this.onFrame(type, (frame) => {
        if (match?.(frame) ?? true) resolve(frame);
      });
    });
  }

  // ── Client → server ──────────────────────────────────────────────────

  /**
   * Send a frame the way a browser does: through the real `message()` handler, into the
   * real connection queue. Everything a test says to the server goes through here.
   */
  async deliver(event: ClientEvent): Promise<void> {
    await this.handlers.message(this.ws, JSON.stringify(event));
  }

  /** Fire a frame without waiting for the server to finish routing it. */
  deliverAsync(event: ClientEvent): Promise<void> {
    return Promise.resolve(this.handlers.message(this.ws, JSON.stringify(event))).then(
      () => undefined,
    );
  }

  // ── Connection lifecycle ─────────────────────────────────────────────

  async open(): Promise<void> {
    await this.handlers.open(this.ws);
  }

  async close(): Promise<void> {
    await this.handlers.close(this.ws);
  }

  /** Wait for every scripted reaction to finish (and rethrow whatever one of them threw). */
  async settleResponders(): Promise<void> {
    while (this.reacting.size > 0) {
      await Promise.all([...this.reacting]);
    }
  }
}
