/**
 * The phone names the monitor a pan is about to create before the server has minted it,
 * so the prediction has to agree with `monitor-registry.ts`'s `mint()`: lowest free id,
 * labelled one past it.
 */
import { describe, it, expect } from 'bun:test';
import { MAX_MONITORS } from '@yaar/shared';
import { monitorNumber, predictNextMonitorLabel } from '@/store/slices/monitorSlice';

const ids = (...list: string[]) => list.map((id) => ({ id }));

describe('predictNextMonitorLabel', () => {
  it('counts on from the monitors there are', () => {
    expect(predictNextMonitorLabel(ids('0'))).toBe('Monitor 2');
    expect(predictNextMonitorLabel(ids('0', '1'))).toBe('Monitor 3');
  });

  it('reuses a gap the way the server does, rather than counting forever', () => {
    expect(predictNextMonitorLabel(ids('0', '2'))).toBe('Monitor 2');
  });

  it('has nothing to offer once the session is full', () => {
    const full = Array.from({ length: MAX_MONITORS }, (_, i) => ({ id: String(i) }));
    expect(predictNextMonitorLabel(full)).toBeNull();
  });
});

describe('monitorNumber', () => {
  it('is the number a monitor label ends in', () => {
    expect(monitorNumber('Monitor 3')).toBe('3');
  });

  it('falls back to the whole label when there is no number to take', () => {
    expect(monitorNumber('Work')).toBe('Work');
  });
});
