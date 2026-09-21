/**
 * Live mode's reactive surface: the signals the view reads and the types the rest
 * of the live/* modules speak in. Imports nothing local, so it can never be half of
 * a cycle.
 */
import { createSignal } from '@bundled/solid-js';
import { createSharedSignal } from '@bundled/yaar';

export interface LiveStats {
  fps: number;
  kbps: number;
  /** ms from an input event to the paint of the first frame after it. */
  lagMs: number;
  /** Frames the server dropped because this link could not keep up. */
  dropped: number;
}

/**
 * The two levers Chrome's screencast actually has. Named for the link they are
 * meant for, because the spike's remaining open question is whether a phone over
 * Tailscale can be served by ramping these rather than by a real video codec.
 */
export const QUALITY_PRESETS = {
  high: { quality: 70, maxWidth: 0 },
  medium: { quality: 45, maxWidth: 1024 },
  low: { quality: 30, maxWidth: 800 },
} as const;

export type QualityPreset = keyof typeof QUALITY_PRESETS;

/**
 * One tab in the live strip.
 *
 * A "tab" here is a remote *target*, not a Chrome tab: a popup Chrome drew as its
 * own window is one of these too. That is the whole trick — the socket can point
 * at any target, so a popup needs no window of its own on this side.
 */
export interface LiveTab {
  browserId: string;
  url: string;
  title: string;
}

export const [liveTabs, setLiveTabs] = createSignal<LiveTab[]>([]);

const remoteLiveModeListeners: ((enabled: boolean, prev: boolean) => void)[] = [];

/**
 * Whether this window shows the live screencast or the still poll — set by
 * set_live_mode and the toolbar's ◉ button (session.ts's `setLive`, the one write
 * site). Shared across copies: it decides which of two render paths the view is
 * on, and a follower left on the old path would show a still screenshot while the
 * agent drives a screencast it can't see. `session.ts` registers the actual
 * connect/disconnect via `onRemoteLiveMode` rather than this module reaching for
 * them, to avoid a cycle back into itself.
 */
export const [liveMode, setLiveMode] = createSharedSignal('liveMode', false, {
  onRemote: (enabled, prev) => remoteLiveModeListeners.forEach((fn) => fn(enabled, prev)),
});

/** Run `fn` when another copy of this window flips into or out of live mode. */
export function onRemoteLiveMode(fn: (enabled: boolean, prev: boolean) => void): void {
  remoteLiveModeListeners.push(fn);
}

export const [quality, setQuality] = createSignal<QualityPreset>('high');
export const [liveStatus, setLiveStatus] = createSignal('');
/**
 * What the IME probe is doing right now — the readout that answers it.
 *
 * `composing` means a preedit is in flight; `caret` / `no caret` says whether the
 * remote page could tell us where to park the candidate window, which is the
 * probe's second question and the one no unit test can answer.
 */
export const [imeStatus, setImeStatus] = createSignal('');
export const [liveStats, setLiveStats] = createSignal<LiveStats>({
  fps: 0,
  kbps: 0,
  lagMs: 0,
  dropped: 0,
});
