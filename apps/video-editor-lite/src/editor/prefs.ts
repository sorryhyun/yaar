import { createPersistedSignal, appStorage } from '@bundled/yaar';
import * as z from '@bundled/zod';
import { EditorPrefsSchema } from './schema';

export interface EditorPrefs {
  playbackRate: number;
  loopPreview: boolean;
  lastUrl: string;
  lastStoragePath: string;
  lastStorageListPath: string;
}

export const ALLOWED_PLAYBACK_RATES = new Set([0.5, 1, 1.5, 2]);

const PREFS_KEY = 'prefs.json';

export const DEFAULT_PREFS: EditorPrefs = {
  playbackRate: 1,
  loopPreview: false,
  lastUrl: '',
  lastStoragePath: '',
  lastStorageListPath: 'mounts/lecture-materials',
};

/** Parse one field, falling back without failing the whole record. */
function field<T>(schema: z.ZodMiniType<T>, value: unknown, fallback: T): T {
  const parsed = z.safeParse(schema, value);
  return parsed.success ? parsed.data : fallback;
}

/**
 * Turn whatever is in prefs.json into a complete, usable EditorPrefs.
 *
 * Shared by both doors into prefs.json — the signal's `revive` below and the
 * awaitable `loadPrefs` — because they used to disagree: only the loader
 * checked anything, so anything the signal read went unvalidated into the
 * player.
 *
 * Recovery is per field, not per record: a drifted `playbackRate` must not cost
 * the user their `lastStorageListPath`, since the fields are independent and a
 * partially readable record is worth more than the defaults. The whole-record
 * `safeParse` therefore serves as the *detector*: it is what makes a broken record
 * loud instead of silently default-shaped, while the field-level parses do the
 * recovery.
 *
 * Two constraints are semantic rather than structural and stay here: the
 * playbackRate allow-list (a rate the player exposes no control for is as
 * unusable as a string), and the blank-vs-missing rule for the storage list path
 * (whitespace means "unset", not "browse the empty path").
 *
 * Total by construction, as `revive` requires: it never throws, and handing it
 * the defaults (what a missing file yields) returns them unchanged and silently.
 */
export function revivePrefs(raw: unknown): EditorPrefs {
  // Nothing stored: degraded by design, not broken — no record means no
  // complaint, on a first launch and in the headless extraction run alike.
  if (raw === null || raw === undefined) return DEFAULT_PREFS;
  const whole = z.safeParse(EditorPrefsSchema, raw);
  if (!whole.success) {
    console.error(
      `[video-editor-lite] ${PREFS_KEY} failed validation; ` +
        'recovering the fields that are still readable',
      whole.error.issues,
    );
  }
  const rec: Record<string, unknown> =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  // A rate outside the set is a value an older build wrote, not corruption:
  // normalized quietly, exactly as before.
  const rate = field(z.number(), rec.playbackRate, DEFAULT_PREFS.playbackRate);
  const listPath = field(z.string(), rec.lastStorageListPath, DEFAULT_PREFS.lastStorageListPath);

  return {
    playbackRate: ALLOWED_PLAYBACK_RATES.has(rate) ? rate : DEFAULT_PREFS.playbackRate,
    loopPreview: field(z.boolean(), rec.loopPreview, DEFAULT_PREFS.loopPreview),
    lastUrl: field(z.string(), rec.lastUrl, DEFAULT_PREFS.lastUrl),
    lastStoragePath: field(z.string(), rec.lastStoragePath, DEFAULT_PREFS.lastStoragePath),
    // Blank is treated as unset: an empty browse path would land the picker
    // nowhere rather than at the default mount.
    lastStorageListPath: listPath.trim() ? listPath : DEFAULT_PREFS.lastStorageListPath,
  };
}

// Signal: auto-persists to storage on every setPrefs() call.
// savePrefs() is no longer needed — just call setPrefs(prev => ({ ...prev, patch })).
export const [prefs, setPrefs] = createPersistedSignal<EditorPrefs>(PREFS_KEY, DEFAULT_PREFS, {
  label: 'editor preferences',
  revive: revivePrefs,
});

/** Awaitable startup loader with field validation (used once in main.ts init block). */
export async function loadPrefs(): Promise<EditorPrefs> {
  // `null` rather than DEFAULT_PREFS as the fallback: revivePrefs already turns
  // "nothing stored" into the defaults, silently, and routing both cases through
  // it keeps this loader and the signal on exactly one code path.
  return revivePrefs(await appStorage.readJsonOr<unknown>(PREFS_KEY, null));
}
