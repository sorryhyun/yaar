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

    expect(runs[0]).toEqual([...runs[0]].sort());
    for (const ids of runs.slice(1)) {
      expect(ids).toEqual(runs[0]);
    }
  });
});
