/**
 * Stream cadence diagnostics — how fast frames move, never what they say.
 *
 * "The agent updates in blocks, not smoothly" has two completely different
 * causes, and they need opposite fixes:
 *
 *   1. the *provider* emitted one large delta (nothing YAAR can smooth), or
 *   2. the provider emitted many small deltas and YAAR's 60ms coalescing merged
 *      them (a tunable, ours).
 *
 * From the outside the two are indistinguishable, so this module samples both
 * seams and lets them be compared:
 *
 *   - **source** — `StreamToEventMapper`, one sample per provider `text`
 *     `StreamMessage`, *before* coalescing;
 *   - **delivery** — `SubscriptionRegistry.deliverFrame`, one sample per frame
 *     actually put on the wire, *after* coalescing.
 *
 * If the two cadences match, the provider is chunking; if delivery is coarser,
 * the merge is. Samples carry a timestamp and a character *count* only — never a
 * delta, never a payload. A transcript must not be reachable through a debug
 * switch.
 *
 * Off unless `YAAR_STREAM_DIAG=1` (or {@link setStreamDiagnosticsEnabled}, for
 * tests), so the hot path costs one boolean check in normal operation.
 */

/** One measurement at one seam. Counts and timing only — no content, by construction. */
export interface StreamCadenceSample {
  /** `Date.now()` when the delta crossed the seam. */
  ts: number;
  /** Character count of the delta. */
  chars: number;
  /** Agent instance id (source seam) or subscription id (delivery seam). */
  key: string;
  /** Frame kind, at the delivery seam. */
  kind?: string;
}

/** Ring cap per seam — diagnostics must never become the memory leak they diagnose. */
const MAX_SAMPLES = 500;

let enabled = process.env.YAAR_STREAM_DIAG === '1';
const source: StreamCadenceSample[] = [];
const delivery: StreamCadenceSample[] = [];

function push(buf: StreamCadenceSample[], sample: StreamCadenceSample): void {
  buf.push(sample);
  if (buf.length > MAX_SAMPLES) buf.splice(0, buf.length - MAX_SAMPLES);
}

/** Turn sampling on/off at runtime. Disabling also drops what was collected. */
export function setStreamDiagnosticsEnabled(on: boolean): void {
  enabled = on;
  if (!on) resetStreamDiagnostics();
}

export function isStreamDiagnosticsEnabled(): boolean {
  return enabled;
}

/** Record a provider-produced text delta, before coalescing. */
export function recordSourceDelta(key: string | undefined, chars: number): void {
  if (!enabled || !key) return;
  push(source, { ts: Date.now(), chars, key });
}

/** Record a frame as delivered to a subscriber, after coalescing. */
export function recordDeliveredFrame(key: string, kind: string, chars: number): void {
  if (!enabled) return;
  push(delivery, { ts: Date.now(), chars, key, kind });
}

/**
 * The collected samples, for a test hook or a debug route.
 *
 * `gapMs` is the interval between consecutive samples at a seam — the cadence
 * itself. Comparing `source.gapMs` with `delivery.gapMs` is the whole point:
 * similar gaps mean the provider set the pace, a coarser delivery gap means the
 * coalescer did.
 */
export function getStreamDiagnostics(): {
  source: StreamCadenceSample[];
  delivery: StreamCadenceSample[];
  summary: {
    source: CadenceSummary;
    delivery: CadenceSummary;
  };
} {
  return {
    source: [...source],
    delivery: [...delivery],
    summary: { source: summarize(source), delivery: summarize(delivery) },
  };
}

export interface CadenceSummary {
  samples: number;
  totalChars: number;
  meanChars: number;
  /** Mean interval between consecutive samples, ms. `null` with fewer than two. */
  meanGapMs: number | null;
}

function summarize(buf: StreamCadenceSample[]): CadenceSummary {
  const totalChars = buf.reduce((sum, s) => sum + s.chars, 0);
  let meanGapMs: number | null = null;
  if (buf.length > 1) {
    meanGapMs = (buf[buf.length - 1].ts - buf[0].ts) / (buf.length - 1);
  }
  return {
    samples: buf.length,
    totalChars,
    meanChars: buf.length > 0 ? totalChars / buf.length : 0,
    meanGapMs,
  };
}

export function resetStreamDiagnostics(): void {
  source.length = 0;
  delivery.length = 0;
}
