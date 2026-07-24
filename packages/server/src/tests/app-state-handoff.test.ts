import { describe, expect, it } from 'bun:test';
import {
  AppStateHandoffStore,
  fingerprintAppState,
  formatAppStateHandoffNotice,
} from '../agents/app-state-handoff.js';

describe('app state handoff fingerprints', () => {
  it('ignores object insertion order across all declared state', () => {
    expect(
      fingerprintAppState({
        cells: { B1: 'two', A1: 'one' },
        selection: { end: 'B1', start: 'A1' },
      }),
    ).toBe(
      fingerprintAppState({
        selection: { start: 'A1', end: 'B1' },
        cells: { A1: 'one', B1: 'two' },
      }),
    );
  });

  it('reports only one aggregate changed-or-unchanged fact', () => {
    const store = new AppStateHandoffStore();
    store.remember('0/excel-lite', {
      cells: { A1: 'Title' },
      styles: {},
      selection: { active: 'A1' },
    });

    expect(
      store.changedSinceHandoff('0/excel-lite', {
        cells: { A1: 'Title' },
        styles: {},
        selection: { active: 'A1' },
      }),
    ).toBe(false);
    expect(
      store.changedSinceHandoff('0/excel-lite', {
        cells: { A1: 'Title', E2: 'Lunch' },
        styles: {},
        selection: { active: 'E2' },
      }),
    ).toBe(true);
    expect(formatAppStateHandoffNotice(true)).toBe('<app_state_since_handoff changed="true" />');
  });
});
