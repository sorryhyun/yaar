import { describe, expect, it } from 'bun:test';
import { listApps, loadAllAppHints } from '../features/apps/discovery.js';

describe('app discovery ordering', () => {
  it('returns apps in stable app-id order', async () => {
    const apps = await listApps();
    const ids = apps.map((app) => app.id);

    expect(ids).toEqual([...ids].sort());
  });

  it('returns hints in stable app-id order across concurrent reads', async () => {
    const runs = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const hints = await loadAllAppHints();
        return hints.map((hint) => hint.appId);
      }),
    );

    // The subject is *order*, not membership. `realfs/agent-docs.test.ts` seeds a real
    // app directory under `user-apps/` from its own process while this one reads, so the
    // app set genuinely can change mid-test — that is an install, which is a thing that
    // happens to a live YAAR, not an ordering bug. Asserting run-to-run identity turned
    // it into a failure here (and would in any session that installed an app at the
    // wrong moment). So: every read is sorted, and any two reads agree on the order of
    // the apps they both saw.
    for (const ids of runs) {
      expect(ids).toEqual([...ids].sort());
    }
    const inEveryRun = runs.reduce((shared, ids) => shared.filter((id) => ids.includes(id)));
    for (const ids of runs) {
      expect(ids.filter((id) => inEveryRun.includes(id))).toEqual(inEveryRun);
    }
  });
});
