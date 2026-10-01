import { appStorage, showToast, storage } from '@bundled/yaar';
import {
  capturePhoto,
  openCamera as openStream,
  recordToStorage,
  stopStream,
} from '@bundled/yaar-media';
import {
  CAPTURE_DIR,
  captures,
  facing,
  recording,
  setBusy,
  setCaptures,
  setFacing,
  setLastError,
  setRecProgress,
  setRecording,
  setStream,
  setViewing,
  stream,
  withAudio,
  type Capture,
  type Facing,
} from './store';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `20261001-153000` — sortable, and unique enough for one camera. */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function kindOf(path: string): Capture['kind'] | null {
  if (/\.(jpe?g|png|webp)$/i.test(path)) return 'photo';
  if (/\.(webm|mp4|m4a|ogg)$/i.test(path)) return 'video';
  return null;
}

/** A URL a `<video>` / `<img>` can load — carries the iframe token. */
export function captureUrl(c: Capture): string {
  return storage.url(`yaar://apps/self/storage/${c.path}`);
}

export async function refreshCaptures(): Promise<Capture[]> {
  try {
    const entries = await appStorage.list(CAPTURE_DIR);
    const list = entries
      .filter((e) => !e.isDirectory)
      .map((e): Capture | null => {
        const path = e.path.startsWith(`${CAPTURE_DIR}/`) ? e.path : `${CAPTURE_DIR}/${e.path}`;
        const kind = kindOf(path);
        return kind ? { path, kind, size: e.size ?? 0, modifiedAt: e.modifiedAt } : null;
      })
      .filter((c): c is Capture => c !== null)
      .sort((a, b) => b.path.localeCompare(a.path));
    setCaptures(list);
    return list;
  } catch {
    // No captures folder yet — nothing has been taken.
    setCaptures([]);
    return [];
  }
}

/** Throws, so a protocol caller hears why the camera did not open. */
export async function startCamera(next?: Facing): Promise<void> {
  if (recording()) throw new Error('Stop the recording before switching cameras');
  if (next) setFacing(next);
  setBusy(true);
  setLastError('');
  try {
    stopStream(stream());
    setStream(null);
    setStream(await openStream({ facingMode: facing(), audio: withAudio() }));
    setViewing(null);
  } catch (err) {
    setLastError(message(err));
    throw err;
  } finally {
    setBusy(false);
  }
}

export async function stopCamera(): Promise<void> {
  if (recording()) await stopRecording();
  stopStream(stream());
  setStream(null);
}

export async function flipCamera(): Promise<void> {
  await startCamera(facing() === 'environment' ? 'user' : 'environment');
}

function requireStream(): MediaStream {
  const s = stream();
  if (!s) throw new Error('The camera is off — open it first');
  return s;
}

export async function takePhoto(): Promise<Capture> {
  const blob = await capturePhoto(requireStream());
  const path = `${CAPTURE_DIR}/photo-${stamp()}.jpg`;
  await storage.save(`yaar://apps/self/storage/${path}`, blob);
  const capture: Capture = { path, kind: 'photo', size: blob.size };
  setCaptures([capture, ...captures()]);
  return capture;
}

export function startRecording(): { path: string; mimeType: string } {
  if (recording()) throw new Error('Already recording');
  const s = requireStream();
  setRecProgress({ bytes: 0, durationMs: 0 });
  const rec = recordToStorage(s, `${CAPTURE_DIR}/video-${stamp()}`, {
    onProgress: (p) => setRecProgress(p),
    onError: (err) => {
      setLastError(`Recording stopped: ${err.message}`);
      void finishRecording(rec);
    },
  });
  setRecording(rec);
  return { path: rec.path, mimeType: rec.mimeType };
}

/** Settle one recording, whether stopped by the user or by a failed upload. */
async function finishRecording(rec: NonNullable<ReturnType<typeof recording>>) {
  try {
    return await rec.stop();
  } finally {
    if (recording() === rec) setRecording(null);
    await refreshCaptures();
  }
}

export async function stopRecording() {
  const rec = recording();
  if (!rec) throw new Error('Not recording');
  const result = await finishRecording(rec);
  showToast(`Saved ${result.path}`, 'success');
  return result;
}

export async function deleteCapture(path: string): Promise<void> {
  await appStorage.remove(path);
  setCaptures(captures().filter((c) => c.path !== path));
}

/** The record button: reports its own failure instead of throwing. */
export async function toggleRecording(): Promise<void> {
  try {
    if (recording()) await stopRecording();
    else startRecording();
  } catch (err) {
    setLastError(message(err));
  }
}

/** Wraps an action for a button, so a failure lands in the error banner. */
export function reporting(fn: () => Promise<unknown>): () => void {
  return () => {
    setLastError('');
    fn().catch((err) => setLastError(message(err)));
  };
}
