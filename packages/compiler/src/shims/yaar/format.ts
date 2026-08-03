// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * The three renderings that must not disagree between two windows on one screen.
 *
 * A file listed as "2.0 MB" in one app and "2 MB" in another is not a bug in
 * either of them, and is still wrong: the OS looks assembled rather than made.
 * The audit found four byte formatters with four unit ladders, three duration
 * formatters with three precisions, and six clock formatters of which half
 * hardcoded `'ko-KR'` — a locale the user did not pick, applied to half the
 * timestamps on screen.
 *
 * `@bundled/date-fns` is bundled and *zero* of those sites reached for it. That
 * is the right instinct: a date library cannot give the thing that actually
 * matters here, which is one answer per value across every window. Calendar
 * *dates* are the opposite case — style there is a legitimate per-app choice —
 * so they stay with `date-fns` and out of this file.
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/**
 * Bytes as a human-readable size: `'0 B'`, `'834 B'`, `'1.5 KB'`, `'2.0 MB'`.
 *
 * Binary steps (1024), one decimal above bytes, none for bytes themselves — a
 * fractional byte is noise. Anything not finite renders `'0 B'` rather than
 * `'NaN B'`; a size is usually incidental to whatever it labels, and a caller
 * that needs to distinguish "zero" from "unknown" has the number.
 */
export function formatBytes(n: number): string {
  const bytes = Number(n);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/**
 * Seconds as elapsed time: `'0:07'`, `'3:07'`, `'1:03:07'`.
 *
 * Hours appear only once there are hours, minutes are always two digits after
 * the first field, and seconds are floored — a media scrubber that rounds shows
 * a duration one second longer than the file it is playing.
 */
export function formatDuration(seconds: number): string {
  const total = Math.floor(Number(seconds));
  if (!Number.isFinite(total) || total <= 0) return '0:00';
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (v) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * A timestamp as a wall clock in the *user's* locale: `'15:04:05'`.
 *
 * 24-hour by choice, not by locale. The values this formats are log lines, save
 * times and frame timings — a column where `'3:04:05 PM'` is two characters of
 * meaning and five of width, and where sorting by eye matters more than reading
 * habit. The locale still decides the separators. Pass `{ seconds: false }` for
 * the `'15:04'` form a "Saved 15:04" label wants.
 */
export function formatClock(ts: number | Date, opts?: { seconds?: boolean }): string {
  const date = ts instanceof Date ? ts : new Date(Number(ts));
  if (Number.isNaN(date.getTime())) return '--:--';
  const options = { hourCycle: 'h23', hour: '2-digit', minute: '2-digit' };
  if (!opts || opts.seconds !== false) options.second = '2-digit';
  return date.toLocaleTimeString(undefined, options);
}
