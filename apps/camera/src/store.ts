import { createSignal } from '@bundled/solid-js';
import type { StorageRecording } from '@bundled/yaar-media';

export type Facing = 'user' | 'environment';

export interface Capture {
  /** Relative to this app's storage, e.g. `captures/video-20261001-153000.webm`. */
  path: string;
  kind: 'photo' | 'video';
  size: number;
  modifiedAt?: string;
}

export const CAPTURE_DIR = 'captures';

export const [stream, setStream] = createSignal<MediaStream | null>(null);
export const [facing, setFacing] = createSignal<Facing>('environment');
export const [withAudio, setWithAudio] = createSignal(true);

export const [recording, setRecording] = createSignal<StorageRecording | null>(null);
/** Bytes on the server and elapsed time of the recording in progress, for the readout. */
export const [recProgress, setRecProgress] = createSignal({ bytes: 0, durationMs: 0 });

export const [captures, setCaptures] = createSignal<Capture[]>([]);
/** The capture shown in the viewer, or null for the live preview. */
export const [viewing, setViewing] = createSignal<Capture | null>(null);

export const [busy, setBusy] = createSignal(false);
export const [lastError, setLastError] = createSignal('');
