/**
 * The spike's instrument: painted fps, link throughput, server-side drops, and —
 * the number that actually matters — input-to-pixel lag, measured client-side from
 * an input event to the paint of the next frame after it. Client and server clocks
 * are unrelated, so nothing here subtracts one from the other.
 *
 * Every reading is over a fixed wall-clock window. It used to advance only when a
 * frame was painted, which made the readout lie in exactly the situation worth
 * measuring: a stream that goes quiet leaves the window open, and the next frame —
 * a tab switch and thirty seconds later — is divided by the whole idle span. That
 * is where `Live 3 fps / 29333 ms` came from, on a link that was never slow. The
 * window is closed by a clock now (`startStatsClock`), so an idle stream reads 0 fps
 * rather than saving up its idleness for the next frame.
 */
import { liveStats, setLiveStats } from './state';
import { noteRepaintOwed, clearRepaintOwed } from './context';

/** Timestamp of the most recent input event that has not yet been answered by a frame. */
let pendingInputAt = 0;

// Rolling window for the stats readout.
let windowStart = 0;
let windowFrames = 0;
let windowBytes = 0;
let windowLagTotal = 0;
let windowLagCount = 0;
let lastDropped = 0;
let clock: ReturnType<typeof setInterval> | null = null;

const WINDOW_MS = 1000;

/**
 * A frame that lands this long after an input is not an answer to that input.
 *
 * Without a bound, one unanswered input poisons every later reading: the mark sits
 * there through a tab switch, a paused page or a stalled stream, and whatever frame
 * eventually arrives reports the entire gap as latency.
 */
const LAG_EXPIRY_MS = 2000;

function resetWindow(): void {
  windowStart = performance.now();
  windowFrames = 0;
  windowBytes = 0;
  windowLagTotal = 0;
  windowLagCount = 0;
}

/**
 * Called on connect and on every tab switch: a new stream's counters must not
 * inherit the last one's, and neither must a new tab's.
 */
export function resetStats(): void {
  resetWindow();
  lastDropped = 0;
  pendingInputAt = 0;
  setLiveStats({ fps: 0, kbps: 0, lagMs: 0, dropped: 0 });
}

/**
 * Mark this moment as the input the next painted frame answers.
 *
 * Only the *first* unanswered input is timed. A drag produces a move every few
 * ms, and overwriting the mark each time would measure "time since the last
 * mousemove", which is always near zero and always flattering.
 */
export function markInput(): void {
  if (!pendingInputAt) pendingInputAt = performance.now();
  // Whatever the timing says, the canvas now owes the user a repaint — which is
  // what fallback.ts watches for when the stream stops answering.
  noteRepaintOwed();
}

/**
 * Close the open lag measurement — pixels reached the screen.
 *
 * Called for a screencast frame and for a still capture alike: what the number
 * means is when the human saw their input land, and it is no less true of a pixel
 * that arrived over HTTP because the stream had gone quiet (fallback.ts).
 */
function closeInputMark(): void {
  clearRepaintOwed();
  if (!pendingInputAt) return;
  const lag = performance.now() - pendingInputAt;
  if (lag <= LAG_EXPIRY_MS) {
    windowLagTotal += lag;
    windowLagCount++;
  }
  pendingInputAt = 0;
}

/** A still capture painted onto the canvas answers the input the same way a frame does. */
export function recordSeedPaint(): void {
  closeInputMark();
}

/** Book one painted frame: it closes the open lag measurement, if there is one. */
export function recordFrame(byteLength: number, dropped?: number): void {
  closeInputMark();
  windowFrames++;
  windowBytes += byteLength;
  lastDropped = dropped ?? lastDropped;
  tickStats();
}

function tickStats(): void {
  const now = performance.now();
  const elapsed = now - windowStart;
  if (elapsed < WINDOW_MS) return;
  const pendingAge = pendingInputAt ? now - pendingInputAt : 0;
  setLiveStats({
    fps: Math.round((windowFrames / elapsed) * 1000),
    kbps: Math.round((windowBytes * 8) / elapsed),
    lagMs: windowLagCount
      ? Math.round(windowLagTotal / windowLagCount)
      : // An input still waiting past the expiry is the honest current reading:
        // reporting the last good number instead would show 14 ms for a stream
        // that has answered nothing at all. A window with nothing outstanding
        // keeps the last reading rather than reporting 0 ms.
        pendingAge > LAG_EXPIRY_MS
        ? Math.round(pendingAge)
        : liveStats().lagMs,
    dropped: lastDropped,
  });
  resetWindow();
}

/**
 * Close the window on a clock rather than on the next frame.
 *
 * This is what makes 0 fps reachable. Started with the socket and stopped with it,
 * so nothing ticks while live mode is off.
 */
export function startStatsClock(): void {
  stopStatsClock();
  clock = setInterval(tickStats, WINDOW_MS);
}

export function stopStatsClock(): void {
  if (!clock) return;
  clearInterval(clock);
  clock = null;
}
