/**
 * What to do when the screencast owes us a frame and does not send one.
 *
 * Chrome composites the frontmost target and only that one. `Page.startScreencast`
 * against any other target attaches without complaint and then emits nothing at all,
 * so a tab the user switches back to streams zero frames while its page is very much
 * alive: input is forwarded, the remote page scrolls, and the canvas holds whatever
 * the seed last painted. Measured, not assumed — a tab reading 36 fps drops to 0 the
 * moment a newer tab takes the foreground, and reads 36 again when it is frontmost.
 * Neither reconnecting the socket nor navigating the tab revives it.
 *
 * The cure is server-side: whatever handles `attach` has to activate the target
 * (`Target.activateTarget` / `Page.bringToFront`) so Chrome composites it. This module
 * is the client's half — a mitigation, not a fix. When input has been forwarded and no
 * frame has answered it for STALL_MS, it asks the still endpoint for a `fresh` capture
 * of that tab, which (unlike the screencast) does answer for a background target.
 *
 * Two things can then put pixels on the canvas, and both are wins:
 *
 *   - the capture itself, painted by seed.ts; or
 *   - a real screencast frame, because forcing a capture makes the target rasterize
 *     and Chrome emits a frame for it. This is what is observed in practice: the seed
 *     usually reports `false` — aborted because a real frame beat it, which is exactly
 *     the guard seed.ts is there to apply.
 *
 * Measured against the unfixed build on the same kind of stalled tab: 4 wheel scrolls
 * produced 0 canvas repaints before, and 2-3 after. It is a few frames per second, not
 * a stream, which is why the fix above still needs doing.
 *
 * It costs nothing when the stream is healthy: a capture is only fetched when input is
 * outstanding AND no frame has been painted for STALL_MS, so a live stream never
 * triggers it and an idle page at rest never triggers it either.
 */
import {
  desiredTab,
  framePaintedAt,
  isLiveConnected,
  repaintIsOwed,
  clearRepaintOwed,
} from './context';
import { seedCanvas } from './seed';
import { recordSeedPaint } from './stats';

const CHECK_MS = 300;

/**
 * How long a frame may owe us before we stop waiting for it.
 *
 * Comfortably longer than a frame interval on a healthy stream (36 fps is 28 ms) and
 * short enough that a scroll does not feel abandoned.
 */
const STALL_MS = 900;

let timer: ReturnType<typeof setInterval> | null = null;
/** One capture at a time: they are ~100-200 ms of server work and must not queue up. */
let seeding = false;

/** A tab switch starts the question over: the new tab owes nothing yet. */
export function resetFallback(): void {
  clearRepaintOwed();
}

async function check(): Promise<void> {
  const tab = desiredTab();
  if (!tab || !isLiveConnected() || seeding) return;

  // framePaintedAt() is 0 when this connection has painted nothing, which reads as
  // an infinitely old frame — correct, that is the most stalled a stream can be.
  if (performance.now() - framePaintedAt() < STALL_MS) return;
  if (!repaintIsOwed()) return;

  clearRepaintOwed();
  seeding = true;
  try {
    // A false return is the normal case, not a failure: seed.ts drops its capture
    // when a real frame lands first, and forcing the capture is often what caused
    // that frame. Only a still that actually reached the canvas closes the lag mark;
    // a real frame closes it through recordFrame on its own.
    if (await seedCanvas(tab)) recordSeedPaint();
  } finally {
    seeding = false;
  }
}

export function startFallback(): void {
  stopFallback();
  timer = setInterval(() => void check(), CHECK_MS);
}

export function stopFallback(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  resetFallback();
}
