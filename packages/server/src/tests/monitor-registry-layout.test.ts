/**
 * Whose report sets a monitor's layout.
 *
 * The viewport and form factor are one per monitor, and both size the windows created on
 * it. On a phone the server parks a companion desktop (`?ui=desktop`) on the same monitor
 * as the phone; when its report won, the phone's monitor went desktop-shaped and new
 * windows opened at 640×480 on a 360-wide screen (#119).
 */
import { describe, it, expect } from 'bun:test';
import type { FormFactor, Orientation } from '@yaar/shared';
import { MonitorRegistry } from '../session/monitor-registry.js';
import type { Viewport } from '../session/layout-context.js';

function registry(companions: string[]) {
  const viewports = new Map<string, Viewport>();
  const formFactors = new Map<string, FormFactor>();
  const orientations = new Map<string, Orientation | undefined>();
  const watching = new Map<string, string>();
  const reg = new MonitorRegistry({
    sessionId: 'sess' as never,
    broadcast: () => {},
    sendTo: () => {},
    subscribeConnection: (c, m) => watching.set(c, m),
    connectionMonitor: (c) => watching.get(c),
    unsubscribeMonitor: () => {},
    isCompanion: (c) => companions.includes(c),
    setViewport: (m, v) => viewports.set(m, v),
    setFormFactor: (m, f) => formFactors.set(m, f),
    setOrientation: (m, o) => orientations.set(m, o),
    clearLayout: () => {},
    removeMonitorAgent: () => {},
  });
  return { reg, viewports, formFactors, orientations, watching };
}

describe('MonitorRegistry.subscribe layout', () => {
  it('keeps the phone’s layout when the companion desktop reports after it', () => {
    const { reg, viewports, formFactors, watching } = registry(['companion']);
    reg.subscribe('phone', '0', { w: 360, h: 697 }, 'mobile');
    reg.subscribe('companion', '0', { w: 1280, h: 800 }, 'desktop');

    expect(formFactors.get('0')).toBe('mobile');
    expect(viewports.get('0')).toEqual({ w: 360, h: 697 });
    // It still watches the monitor — the half of subscribing it exists for.
    expect(watching.get('companion')).toBe('0');
  });

  it('still lets a real desktop tab take the monitor back from a phone', () => {
    const { reg, viewports, formFactors } = registry(['companion']);
    reg.subscribe('phone', '0', { w: 360, h: 697 }, 'mobile');
    reg.subscribe('laptop', '0', { w: 1440, h: 900 });

    expect(formFactors.get('0')).toBe('desktop');
    expect(viewports.get('0')).toEqual({ w: 1440, h: 900 });
  });

  it('records the phone’s orientation, and a desktop tab taking over clears it', () => {
    const { reg, orientations } = registry(['companion']);
    reg.subscribe('phone', '0', { w: 697, h: 330 }, 'mobile', 'landscape');
    reg.subscribe('companion', '0', { w: 1280, h: 800 }, 'desktop', 'landscape');
    expect(orientations.get('0')).toBe('landscape');

    reg.subscribe('phone', '0', { w: 360, h: 697 }, 'mobile', 'portrait');
    expect(orientations.get('0')).toBe('portrait');

    reg.subscribe('laptop', '0', { w: 1440, h: 900 });
    expect(orientations.get('0')).toBeUndefined();
  });
});
