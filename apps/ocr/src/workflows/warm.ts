// Getting the weights onto the machine, as a step of its own.
//
// A page read needs a detector and every selected recognizer — 152 MB at the default
// sizes, more than either half suggests. Pulling that as a side effect of pressing "Read
// page" made one action mean two very different things: a 300 ms read once warm, and a
// multi-minute download on a cold start, with no way to tell which you were about to get
// and no way to stop it once started.
//
// So the download is its own button and its own command. A read now *asserts* the models
// are here rather than fetching them, and says which are missing when they are not.
// `ensureModels` is still the only path that loads them, so "loaded" cannot drift from
// what a read would actually use — an explicit load and a `download: true` read record
// themselves identically.
//
// Loaded-ness is tracked for this page session only, deliberately, and it means
// *resident in this page* — an ORT session on the GPU — not *downloaded*. The bytes live
// on disk under the app's own storage (weights.ts), so a load after a reload re-reads
// them locally in about a second, but the session itself does not survive a reload and
// claiming otherwise would put the silent multi-minute wait back in the one place it was
// removed.
import { loadCharset } from '../engine/charset';
import { DET_MODELS, detModelById, loadDetector } from '../engine/detect';
import { MODELS, loadRecognizer, modelById, type LoadProgress } from '../engine/model';
import { loadedModels, setLoadedModels, setLoading } from '../state';

export interface ModelRef {
  /** Unique across kinds: a detector and a recognizer may share an id. */
  key: string;
  kind: 'detector' | 'recognizer';
  id: string;
  label: string;
  bytes: number;
}

function detRef(id: string): ModelRef {
  const m = detModelById(id);
  return { key: `det:${m.id}`, kind: 'detector', id: m.id, label: m.label, bytes: m.bytes };
}

function recRef(id: string): ModelRef {
  const m = modelById(id);
  return { key: `rec:${m.id}`, kind: 'recognizer', id: m.id, label: m.label, bytes: m.bytes };
}

/** Everything a page read with these settings needs, detector first. */
export function pageModels(recIds: string[], detId: string): ModelRef[] {
  return [detRef(detId), ...recIds.map(recRef)];
}

/** Everything a selection read needs — no detector, so no 62 MB. */
export function regionModels(recIds: string[]): ModelRef[] {
  return recIds.map(recRef);
}

/** Every model that could be loaded, for a UI that wants to list them. */
export function allModels(): ModelRef[] {
  return [...DET_MODELS.map((m) => detRef(m.id)), ...MODELS.map((m) => recRef(m.id))];
}

export function isLoaded(key: string): boolean {
  return loadedModels().includes(key);
}

export function missing(refs: ModelRef[]): ModelRef[] {
  return refs.filter((ref) => !isLoaded(ref.key));
}

export function bytesOf(refs: ModelRef[]): number {
  return refs.reduce((n, ref) => n + ref.bytes, 0);
}

export function formatBytes(bytes: number): string {
  return bytes >= 1_000_000
    ? `${Math.round(bytes / 1_000_000)} MB`
    : `${Math.round(bytes / 1000)} KB`;
}

/**
 * Refuse a read that would have to download, naming what is missing.
 *
 * The message is the whole point of the gate: it has to say what would be fetched, how
 * big it is, and both ways to ask for it — the button for a person, the command for an
 * agent — because whoever hits this is by definition someone who did not expect a
 * download to be about to happen.
 */
export function requireLoaded(refs: ModelRef[]): void {
  const absent = missing(refs);
  if (absent.length === 0) return;
  throw new Error(
    `${absent.map((m) => `${m.kind} ${m.id}`).join(' and ')} ` +
      `${absent.length === 1 ? 'is' : 'are'} not loaded (${formatBytes(bytesOf(absent))} to ` +
      'download). Press "Load models", or run the loadModels command, or pass ' +
      'download: true to fetch them as part of this read.',
  );
}

export interface EnsureOptions {
  /** Overall progress across the whole set, 0..1. */
  onProgress?: (ratio: number) => void;
  /** Called as each model starts, for a status line that names it. */
  onModel?: (ref: ModelRef, index: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * The load in flight, so anything can stop it.
 *
 * A 152 MB download the user cannot abandon is most of what made the implicit one bad,
 * and the abort has to reach a `fetch` several layers down. Kept here rather than handed
 * in by each caller so the toolbar's Cancel stops a download started by a `download:true`
 * read too — one download at a time, one thing that stops it.
 */
let inflight: AbortController | null = null;

export function cancelLoad(): void {
  inflight?.abort();
}

export interface EnsureResult {
  loaded: ModelRef[];
  bytes: number;
  elapsedMs: number;
}

/**
 * Make sure every model in `refs` is resident. Already-loaded ones cost nothing.
 *
 * Sequential, and not only for the progress bar: `session()` memoizes by URL, so two
 * concurrent loads of the same weights would be one download either way, but two
 * *different* 77 MB downloads racing on one connection just make both slower and the
 * remaining-time estimate meaningless.
 *
 * A recognizer's dictionary is loaded here too. It is 114 KB against 77 MB of weights,
 * but it is a second network fetch, and leaving it to the first read would mean a read
 * that reported everything loaded and then went to the network anyway.
 */
export async function ensureModels(
  refs: ModelRef[],
  options: EnsureOptions = {},
): Promise<EnsureResult> {
  const pending = missing(refs);
  const started = performance.now();
  if (pending.length === 0) return { loaded: [], bytes: 0, elapsedMs: 0 };

  const total = bytesOf(pending);
  let done = 0;

  const controller = new AbortController();
  inflight = controller;
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  setLoading(true);
  try {
    for (const [index, ref] of pending.entries()) {
      options.onModel?.(ref, index, pending.length);
      const onProgress = (p: LoadProgress) =>
        options.onProgress?.(total > 0 ? Math.min(1, (done + p.loaded) / total) : 0);

      if (ref.kind === 'detector') {
        await loadDetector(ref.id, onProgress, controller.signal);
      } else {
        await loadRecognizer(ref.id, onProgress, controller.signal);
        await loadCharset(modelById(ref.id).charset);
      }

      done += ref.bytes;
      options.onProgress?.(total > 0 ? Math.min(1, done / total) : 1);
      // Recorded per model rather than after the loop, so a cancelled load keeps
      // whatever finished — the next attempt resumes instead of starting over.
      setLoadedModels((prev) => (prev.includes(ref.key) ? prev : [...prev, ref.key]));
    }
  } catch (e) {
    // An aborted fetch surfaces as a DOMException whose message is about signals, which
    // is not what happened as far as anyone watching is concerned.
    if (controller.signal.aborted) throw new Error('model download cancelled');
    throw e;
  } finally {
    setLoading(false);
    if (inflight === controller) inflight = null;
  }

  return { loaded: pending, bytes: total, elapsedMs: performance.now() - started };
}
