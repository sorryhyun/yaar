import { describe, it, expect } from 'bun:test';
import {
  MIN_INTERVAL_MS,
  describeSchedule,
  latestDueSlot,
  parseAt,
  parseEvery,
  validateSchedule,
} from '../features/config/hook-schedule.js';

const at = (iso: string) => new Date(iso);

describe('parseEvery', () => {
  it('parses every unit', () => {
    expect(parseEvery('90s')).toBe(90_000);
    expect(parseEvery('15m')).toBe(900_000);
    expect(parseEvery('2h')).toBe(7_200_000);
    expect(parseEvery('1d')).toBe(86_400_000);
  });

  it('refuses anything under the cost floor', () => {
    expect(parseEvery('30s')).toBeNull();
    expect(parseEvery('0m')).toBeNull();
    expect(parseEvery('1m')).toBe(MIN_INTERVAL_MS);
  });

  it('refuses malformed specs', () => {
    expect(parseEvery('15')).toBeNull();
    expect(parseEvery('m')).toBeNull();
    expect(parseEvery('15 minutes')).toBeNull();
    expect(parseEvery('-5m')).toBeNull();
  });
});

describe('parseAt', () => {
  it('accepts 24-hour times', () => {
    expect(parseAt('09:00')).toEqual({ hours: 9, minutes: 0 });
    expect(parseAt('23:59')).toEqual({ hours: 23, minutes: 59 });
  });

  it('refuses out-of-range and 12-hour forms', () => {
    expect(parseAt('24:00')).toBeNull();
    expect(parseAt('9:00')).toBeNull();
    expect(parseAt('09:60')).toBeNull();
    expect(parseAt('9am')).toBeNull();
  });
});

describe('validateSchedule', () => {
  it('accepts exactly one of every/at', () => {
    expect(validateSchedule({ every: '15m' })).toBeNull();
    expect(validateSchedule({ at: '09:00' })).toBeNull();
  });

  it('refuses zero or both', () => {
    expect(validateSchedule({})).toContain('exactly one');
    expect(validateSchedule({ every: '15m', at: '09:00' })).toContain('exactly one');
  });

  it('explains a sub-minute interval rather than clamping it', () => {
    expect(validateSchedule({ every: '5s' })).toContain('at least 1m');
  });
});

describe('latestDueSlot — every', () => {
  const anchor = at('2026-08-15T10:00:00.000Z');

  it('is not due before one interval has passed', () => {
    expect(latestDueSlot({ every: '15m' }, anchor, at('2026-08-15T10:14:59.000Z'))).toBeNull();
  });

  it('returns the slot, not the moment the tick noticed it', () => {
    // A 30s tick sees this 12s late; the recorded run must still be :15:00, or the
    // schedule walks forward by the tick interval on every fire.
    const slot = latestDueSlot({ every: '15m' }, anchor, at('2026-08-15T10:15:12.000Z'));
    expect(slot?.toISOString()).toBe('2026-08-15T10:15:00.000Z');
  });

  it('collapses a long outage into one occurrence', () => {
    const slot = latestDueSlot({ every: '15m' }, anchor, at('2026-08-15T18:07:00.000Z'));
    expect(slot?.toISOString()).toBe('2026-08-15T18:00:00.000Z');
  });

  it('does not drift when the returned slot is used as the next anchor', () => {
    let cursor = anchor;
    for (let tick = 1; tick <= 4; tick++) {
      const now = new Date(anchor.getTime() + tick * 900_000 + 7_000);
      const slot = latestDueSlot({ every: '15m' }, cursor, now);
      expect(slot).not.toBeNull();
      cursor = slot!;
    }
    expect(cursor.toISOString()).toBe('2026-08-15T11:00:00.000Z');
  });

  it('refuses a spec below the floor rather than firing every tick', () => {
    expect(latestDueSlot({ every: '1s' }, anchor, at('2026-08-15T10:00:30.000Z'))).toBeNull();
  });
});

describe('latestDueSlot — at', () => {
  // Local time, because that is what the user typed. Built from parts so the test does
  // not assume the machine's timezone.
  const localAt = (year: number, month: number, day: number, hours: number, minutes: number) =>
    new Date(year, month - 1, day, hours, minutes, 0, 0);

  it('fires once when the browser opens hours after the slot', () => {
    const anchor = localAt(2026, 8, 14, 9, 0);
    const slot = latestDueSlot({ at: '09:00' }, anchor, localAt(2026, 8, 15, 16, 30));
    expect(slot?.getTime()).toBe(localAt(2026, 8, 15, 9, 0).getTime());
  });

  it('is not due again the same day', () => {
    const anchor = localAt(2026, 8, 15, 9, 0);
    expect(latestDueSlot({ at: '09:00' }, anchor, localAt(2026, 8, 15, 23, 0))).toBeNull();
  });

  it('does not fire retroactively for a slot older than the hook', () => {
    // Registered at 10am; this morning's 09:00 is not owed to it.
    const createdAt = localAt(2026, 8, 15, 10, 0);
    expect(latestDueSlot({ at: '09:00' }, createdAt, localAt(2026, 8, 15, 10, 30))).toBeNull();
  });

  it('fires the next day once the slot comes round', () => {
    const anchor = localAt(2026, 8, 15, 10, 0);
    const slot = latestDueSlot({ at: '09:00' }, anchor, localAt(2026, 8, 16, 9, 0));
    expect(slot?.getTime()).toBe(localAt(2026, 8, 16, 9, 0).getTime());
  });

  it('skips the days a laptop was closed instead of replaying them', () => {
    const anchor = localAt(2026, 8, 10, 9, 0);
    const slot = latestDueSlot({ at: '09:00' }, anchor, localAt(2026, 8, 15, 9, 5));
    expect(slot?.getTime()).toBe(localAt(2026, 8, 15, 9, 0).getTime());
  });
});

describe('describeSchedule', () => {
  it('renders both forms', () => {
    expect(describeSchedule({ every: '30m' })).toBe('every 30m');
    expect(describeSchedule({ at: '09:00' })).toBe('daily at 09:00');
  });
});
