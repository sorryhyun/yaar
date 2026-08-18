/**
 * Live mode — the pre-P0 spike for the interactive browser.
 *
 * The still-screenshot path (actions.ts + sse.ts) polls a WebP every 200 ms and
 * shows the agent's browser. Live mode opens a WebSocket to
 * `/api/browser/{id}/screencast`, paints CDP frames onto a canvas, and forwards
 * the human's pointer/wheel/key events straight back into the same remote tab.
 *
 * This file is the seam the rest of the app imports; the implementation is six
 * modules, each one answerable for a single part of that sentence:
 *
 *   state.ts    signals and types — the reactive surface the view reads
 *   fallback.ts still captures for a stream that has gone silent
 *   context.ts  the socket, canvas, IME anchor and remote viewport
 *   socket.ts   connect/disconnect and the text control protocol
 *   paint.ts    binary frame → pixels on the canvas
 *   stats.ts    fps / kbps / dropped / input-to-pixel lag
 *   input.ts    pointer, wheel, keyboard and viewport sync
 *   ime.ts      the hidden anchor that makes composition possible
 *
 * The spike's question is "does this feel good in the hand?", so stats.ts is
 * the instrument that answers it — in particular input-to-pixel lag, measured
 * client-side from an input event to the paint of the next frame after it. Client
 * and server clocks are unrelated, so nothing here subtracts one from the other.
 *
 * Not here, on purpose (they are P0, not the spike): a compositor capture mode
 * with an escape hatch, touch, file drop, the agent co-drive lock.
 *
 * IME *is* here, as a second probe — see ime.ts. It is P0's highest-risk item
 * ("ships in the first cut or the first cut doesn't ship"), so it gets measured on
 * the spike's socket before P0 commits to a design, on the same principle as the
 * frame counters above.
 */
export * from './state';
export * from './context';
export * from './socket';
export * from './stats';
export * from './input';
export * from './ime';
export * from './seed';
export * from './tabs';
export * from './fallback';
