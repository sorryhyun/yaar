/**
 * useClientPresence — what a tab says when it stops being able to answer, and what it does
 * when it can again.
 *
 * The reason this hook exists at all: an open socket is not a live desktop. A backgrounded
 * tab keeps its WebSocket while running no script, so the server goes on addressing a page
 * that cannot hear it and every wait expires blaming the app. Two behaviors follow, and
 * both are asserted here — the report going out *before* the tab stops, and the recovery
 * running when it comes back.
 *
 * The recovery half is gated on purpose, so most of these cases assert that it does *not*
 * run. A resync replaces the desktop from a snapshot — surfaces rebuilt, dialogs dropped,
 * a round trip for every window — and firing one on every glance at another app pays that
 * for nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { renderHook } from '@testing-library/react';
import type { ClientEvent } from '@yaar/shared';
import { useClientPresence } from '@/hooks/use-agent-connection/useClientPresence';
import { wsManager } from '@/lib/transport/transport-manager';

function fakeOpenSocket(): WebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(data),
    sent,
  } as unknown as WebSocket & { sent: string[] };
}

const framesOf = (ws: { sent: string[] }): ClientEvent[] =>
  ws.sent.map((raw) => JSON.parse(raw) as ClientEvent);

const presenceStates = (ws: { sent: string[] }): string[] =>
  framesOf(ws)
    .filter((f) => f.type === 'CLIENT_PRESENCE')
    .map((f) => (f as { state: string }).state);

/**
 * happy-dom's own `Event`, not Bun's global one.
 *
 * `test-setup.ts` only installs a DOM global when Bun does not already provide it, and Bun
 * has `Event` — so the global here is Bun's, and happy-dom's `dispatchEvent` rejects an
 * instance of it outright. (`MouseEvent` elsewhere in these tests works precisely because
 * Bun has no such global.)
 */
const domEvent = (type: string): Event => new window.Event(type);

/** happy-dom's `visibilityState` is a getter, so the test redefines it rather than assigning. */
function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    value,
    configurable: true,
  });
  document.dispatchEvent(domEvent('visibilitychange'));
}

describe('useClientPresence', () => {
  let ws: WebSocket & { sent: string[] };
  let recovered: number;
  const realNow = Date.now;

  beforeEach(() => {
    ws = fakeOpenSocket();
    wsManager.ws = ws;
    recovered = 0;
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
  });

  afterEach(() => {
    wsManager.ws = null;
    Date.now = realNow;
  });

  const mount = () => renderHook(() => useClientPresence(() => void recovered++));

  it('reports the tab going away, and coming back', () => {
    const hook = mount();

    setVisibility('hidden');
    setVisibility('visible');

    expect(presenceStates(ws)).toEqual(['hidden', 'visible']);
    hook.unmount();
  });

  it('reports a freeze the browser announces', () => {
    const hook = mount();

    window.dispatchEvent(domEvent('freeze'));

    expect(presenceStates(ws)).toEqual(['frozen']);
    hook.unmount();
  });

  it('does not resync after a glance away', () => {
    // A flick to another app and straight back: nothing can have timed out, and a resync
    // would replace the desktop from a snapshot for no reason.
    let clock = 10_000;
    Date.now = () => clock;
    const hook = mount();

    setVisibility('hidden');
    clock += 500;
    setVisibility('visible');

    expect(recovered).toBe(0);
    hook.unmount();
  });

  it('resyncs after being away long enough for a wait to have died', () => {
    let clock = 10_000;
    Date.now = () => clock;
    const hook = mount();

    setVisibility('hidden');
    clock += 30_000;
    setVisibility('visible');

    expect(recovered).toBe(1);
    hook.unmount();
  });

  it('resyncs on `resume` however brief the freeze, because the browser said it stopped us', () => {
    // The duration threshold is a fallback for platforms that freeze silently. When the
    // browser tells us outright, the clock is not the evidence.
    let clock = 10_000;
    Date.now = () => clock;
    const hook = mount();

    window.dispatchEvent(domEvent('freeze'));
    clock += 100;
    window.dispatchEvent(domEvent('resume'));

    expect(recovered).toBe(1);
    expect(presenceStates(ws)).toEqual(['frozen', 'visible']);
    hook.unmount();
  });

  it('announces a tab that was already hidden when it mounted', () => {
    // Restored on startup, or opened in the background: a tab nobody has heard from is
    // not the same as a tab known to be away, and the server must not have to guess.
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    const hook = mount();

    expect(presenceStates(ws)).toEqual(['hidden']);
    hook.unmount();
  });

  it('says nothing down a socket that is not open', () => {
    // A closed socket means the server already knows more than this would tell it — and
    // on reconnect the tab announces itself again anyway.
    wsManager.ws = null;
    const hook = mount();

    setVisibility('hidden');

    expect(ws.sent).toHaveLength(0);
    hook.unmount();
  });

  it('stops listening once unmounted', () => {
    const hook = mount();
    hook.unmount();

    setVisibility('hidden');

    expect(ws.sent).toHaveLength(0);
  });
});
