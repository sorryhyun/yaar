/**
 * Hook schedule math — when a `schedule` hook is due.
 *
 * Pure, and deliberately so: the tick loop reads a clock, this file is handed one.
 *
 * The whole model is `latestDueSlot`, which answers "what is the most recent moment
 * this hook should have fired that it hasn't fired yet?" — never "how many did we
 * miss". A daily hook that came due four times while the browser was closed comes
 * back as one slot, so a laptop opened on Friday gets one morning briefing rather
 * than four; every fire of an `interaction` hook is a paid agent turn.
 *
 * The slot, not `now`, is what the caller records as the run. Recording `now` would
 * push the schedule forward by up to one tick on every fire, and a 15m hook checked
 * every 30s would be a 20m hook by the end of the day.
 */

/**
 * The shortest interval a hook may ask for.
 *
 * Not a tick-resolution limit — the scheduler could poll faster. It is a cost floor:
 * an `interaction` hook is a full agent turn, and a mistyped `1s` would bill one every
 * second with nothing to stop it.
 */
export const MIN_INTERVAL_MS = 60_000;

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export interface HookSchedule {
  /** Fixed interval from the last run: `'15m'`, `'2h'`, `'1d'`. At least `1m`. */
  every?: string;
  /** Daily wall-clock time in the server's local timezone, 24-hour `'HH:MM'`. */
  at?: string;
}

/** Milliseconds for an `every` spec, or null if it is malformed or below the floor. */
export function parseEvery(spec: string): number | null {
  const match = /^(\d+)(s|m|h|d)$/.exec(spec.trim());
  if (!match) return null;
  const count = Number(match[1]);
  if (!count) return null;
  const ms = count * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  return ms >= MIN_INTERVAL_MS ? ms : null;
}

/** Hours and minutes for an `at` spec, or null if it is not a 24-hour local time. */
export function parseAt(spec: string): { hours: number; minutes: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(spec.trim());
  if (!match) return null;
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

/**
 * Why this schedule cannot be used, or null if it can.
 *
 * Returns the message the user sees, so it says what to type instead of what was wrong.
 */
export function validateSchedule(schedule: HookSchedule): string | null {
  const given = [schedule.every, schedule.at].filter((value) => value !== undefined);
  if (given.length !== 1) {
    return 'A schedule needs exactly one of `every` (e.g. "15m") or `at` (e.g. "09:00").';
  }
  if (schedule.every !== undefined && parseEvery(schedule.every) === null) {
    return '`every` must be a count and a unit — "90s", "15m", "2h", "1d" — and at least 1m, because every fire of an interaction hook is a paid agent turn.';
  }
  if (schedule.at !== undefined && parseAt(schedule.at) === null) {
    return '`at` must be a 24-hour local time, e.g. "09:00".';
  }
  return null;
}

/** One-line rendering for logs and the hooks list. */
export function describeSchedule(schedule: HookSchedule): string {
  if (schedule.every) return `every ${schedule.every}`;
  if (schedule.at) return `daily at ${schedule.at}`;
  return 'never';
}

/**
 * The most recent occurrence at or before `now` that is strictly after `anchor`, or null
 * if the hook is not due.
 *
 * `anchor` is the hook's last run, or its creation time if it has never run — which is
 * why registering an `at: "09:00"` hook at 10am does not fire it retroactively at 10:01.
 */
export function latestDueSlot(
  schedule: HookSchedule,
  anchor: Date,
  now: Date,
): Date | null {
  const slot = schedule.every
    ? intervalSlot(schedule.every, anchor, now)
    : schedule.at
      ? dailySlot(schedule.at, now)
      : null;
  if (!slot) return null;
  return slot.getTime() > anchor.getTime() && slot.getTime() <= now.getTime() ? slot : null;
}

function intervalSlot(spec: string, anchor: Date, now: Date): Date | null {
  const intervalMs = parseEvery(spec);
  if (!intervalMs) return null;
  const elapsed = now.getTime() - anchor.getTime();
  if (elapsed < intervalMs) return null;
  return new Date(anchor.getTime() + Math.floor(elapsed / intervalMs) * intervalMs);
}

/**
 * Today's `HH:MM` if it has already passed, else yesterday's.
 *
 * Built by mutating a local Date rather than by subtracting 24h, so the day a clock
 * shifts still has one 09:00 in it.
 */
function dailySlot(spec: string, now: Date): Date | null {
  const time = parseAt(spec);
  if (!time) return null;
  const slot = new Date(now);
  slot.setHours(time.hours, time.minutes, 0, 0);
  if (slot.getTime() > now.getTime()) slot.setDate(slot.getDate() - 1);
  return slot;
}
