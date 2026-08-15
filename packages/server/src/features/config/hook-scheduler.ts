/**
 * The clock behind `schedule` hooks.
 *
 * One process-wide interval, not one timer per hook and not one per session: hooks are a
 * property of the machine's config file, and a session that happens to be open is only
 * where the result is delivered. `startHookScheduler()` is called once from `lifecycle.ts`.
 *
 * Two rules decide everything here, and both exist because a timer fires whether or not
 * anyone is watching:
 *
 *   - **A due occurrence with nowhere to go is dropped, not banked.** No connected
 *     session, or a busy monitor, and the slot is marked run anyway. The alternative is a
 *     queue of "good morning" turns that all detonate when a laptop opens at 4pm.
 *   - **A timer never boots a session.** An agent turn nobody is looking at costs real
 *     tokens and emits window actions into a session that will be evicted unread.
 */

import { DEFAULT_MONITOR_ID } from '@yaar/shared';
import { getSessionHub } from '../../session/session-hub.js';
import { createLogger } from '../../observability/log.js';
import { getHooksByEvent, markHookRun, type Hook } from './hooks.js';
import { latestDueSlot } from './hook-schedule.js';

const log = createLogger('HookScheduler');

/**
 * How often the clock is read — not the resolution a hook may ask for, which is floored
 * separately at `MIN_INTERVAL_MS`. Slots are computed from wall-clock time rather than
 * counted in ticks, so this interval only bounds how *late* a hook fires, never how often.
 */
const TICK_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function startHookScheduler(intervalMs: number = TICK_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    void runScheduleTick();
  }, intervalMs);
  // The HTTP server is what keeps this process alive; a config timer should not be able
  // to hold it open on its own.
  timer.unref?.();
  log.info('hook scheduler started', { intervalMs });
}

export function stopHookScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * One pass over the schedule hooks. Exported for tests; production calls it on the interval.
 *
 * Re-entrancy is refused rather than queued — a tick that is still delivering when the
 * next one fires would compute the same slots against a `lastRunAt` it has not written yet.
 */
export async function runScheduleTick(now: Date = new Date()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const hooks = await getHooksByEvent('schedule');
    for (const hook of hooks) {
      const slot = dueSlot(hook, now);
      if (!slot) continue;
      // Recorded before the delivery, and recorded even when the delivery is skipped:
      // this occurrence is spent either way. See the header.
      await markHookRun(hook.id, slot);
      await deliver(hook, slot);
    }
  } catch (err) {
    log.error('schedule tick failed', { err });
  } finally {
    ticking = false;
  }
}

/**
 * The occurrence this hook owes, anchored on its last run — or on its creation, so that
 * registering a `09:00` hook at 10am does not fire it a minute later for this morning.
 */
function dueSlot(hook: Hook, now: Date): Date | null {
  if (!hook.schedule) return null;
  const anchor = new Date(hook.lastRunAt ?? hook.createdAt);
  if (Number.isNaN(anchor.getTime())) {
    log.warn('schedule hook has an unreadable anchor', { hookId: hook.id });
    return null;
  }
  return latestDueSlot(hook.schedule, anchor, now);
}

async function deliver(hook: Hook, slot: Date): Promise<void> {
  const monitorId = hook.monitorId ?? DEFAULT_MONITOR_ID;
  const sessions = getSessionHub()
    .all()
    .filter((session) => session.hasConnections() && session.hasMonitor(monitorId));

  if (sessions.length === 0) {
    log.info('schedule hook dropped — nobody is connected', {
      hookId: hook.id,
      slot: slot.toISOString(),
    });
    return;
  }

  for (const session of sessions) {
    if (hook.action.type === 'interaction' && session.isMonitorBusy(monitorId)) {
      log.info('schedule hook dropped — monitor is busy', { hookId: hook.id, monitorId });
      continue;
    }
    try {
      await session.runHookAction(hook, monitorId);
      log.info('schedule hook fired', {
        hookId: hook.id,
        monitorId,
        action: hook.action.type,
        slot: slot.toISOString(),
      });
    } catch (err) {
      log.error('schedule hook failed', { hookId: hook.id, monitorId, err });
    }
  }
}
