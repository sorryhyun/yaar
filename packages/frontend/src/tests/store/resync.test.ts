/**
 * Acceptance for "the reconnect snapshot replaces state, it does not merge into it" (F-1),
 * plus the outbox (F-2): a command survives a closed socket. Both findings are described in
 * packages/server/src/tests/message-delivery.test.ts, the server side of the same rules.
 *
 * The bug these pin: `applyActions` can only ever *add*. Every reconnect ran the server's
 * windows through it and called that a resync — so anything that happened in the other
 * direction during the outage was invisible. A window an agent closed stayed on screen,
 * clickable, wired to a window the server had already forgotten. A spinner for an agent
 * that finished ran until the tab was reloaded.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { useDesktopStore } from '@/store';
import { toWindowKey } from '@/store/helpers';
import type { OSAction, ClientEvent } from '@yaar/shared';

const MONITOR = '0';

function windowAction(id: string): OSAction {
  return {
    type: 'window.create',
    windowId: toWindowKey(MONITOR, id),
    title: id,
    bounds: { x: 0, y: 0, w: 200, h: 200 },
    content: { renderer: 'markdown', data: '# hi' },
  } as OSAction;
}

beforeEach(() => {
  useDesktopStore.setState({
    windows: {},
    zOrder: [],
    focusedWindowId: null,
    notifications: {},
    dialogs: {},
    userPrompts: {},
    activeAgents: {},
    queuedActions: {},
    activityLog: [],
    activeMonitorId: MONITOR,
    outbox: [],
    messageStatuses: {},
  });
});

describe('applySnapshot — the server is authoritative', () => {
  it('removes a window the server no longer has', () => {
    const store = useDesktopStore.getState();
    store.applyActions([windowAction('notes'), windowAction('todo')]);
    expect(Object.keys(useDesktopStore.getState().windows)).toHaveLength(2);

    // The agent closed `todo` while the socket was down. The snapshot simply does not
    // mention it — and that silence is what has to remove it.
    store.applySnapshot([windowAction('notes')], []);

    const windows = useDesktopStore.getState().windows;
    expect(Object.keys(windows)).toEqual([toWindowKey(MONITOR, 'notes')]);
    expect(useDesktopStore.getState().zOrder).toEqual([toWindowKey(MONITOR, 'notes')]);
  });

  it('drops focus that pointed at a window the server does not have', () => {
    const store = useDesktopStore.getState();
    store.applyActions([windowAction('notes'), windowAction('gone')]);
    expect(useDesktopStore.getState().focusedWindowId).toBe(toWindowKey(MONITOR, 'gone'));

    store.applySnapshot([windowAction('notes')], []);

    expect(useDesktopStore.getState().focusedWindowId).toBe(toWindowKey(MONITOR, 'notes'));
  });

  it('clears the spinner for an agent that finished while we were away', () => {
    const store = useDesktopStore.getState();
    store.setAgentActive('agent-ghost', 'thinking');
    store.setAgentActive('agent-live', 'thinking');

    // Only one of them is still running. The other's spinner used to run forever, because
    // nothing but an explicit disconnect ever cleared activeAgents.
    store.applySnapshot([], [{ agentId: 'agent-live', status: 'working', monitorId: MONITOR }]);

    const agents = useDesktopStore.getState().activeAgents;
    expect(Object.keys(agents)).toEqual(['agent-live']);
    expect(agents['agent-live'].status).toBe('working');
  });

  it('takes down a dialog that was answered or expired during the outage, and keeps one still waiting', () => {
    const store = useDesktopStore.getState();
    store.applyActions([
      { type: 'dialog.confirm', id: 'd-stale', title: 'Gone', message: 'Gone?' } as OSAction,
    ]);
    expect(Object.keys(useDesktopStore.getState().dialogs)).toEqual(['d-stale']);

    store.applySnapshot(
      [{ type: 'dialog.confirm', id: 'd-live', title: 'Still', message: 'Still?' } as OSAction],
      [],
    );

    expect(Object.keys(useDesktopStore.getState().dialogs)).toEqual(['d-live']);
  });

  it('rebuilds a restored window through the ordinary reducer, so it is a real window', () => {
    useDesktopStore.getState().applySnapshot([windowAction('notes')], []);

    const win = useDesktopStore.getState().windows[toWindowKey(MONITOR, 'notes')];
    expect(win).toBeDefined();
    expect(win.title).toBe('notes');
    expect(win.monitorId).toBe(MONITOR);
  });
});

describe('outbox — a command is either acknowledged or visibly still unsent', () => {
  const event = { type: 'USER_MESSAGE', messageId: 'm-1', content: 'hi' } as unknown as ClientEvent;

  it('holds the whole event, attachments and all, until the server acks it', () => {
    const store = useDesktopStore.getState();
    store.enqueueOutbox('m-1', event);

    // This is what makes a retry possible at all: the drawing and images were consumed out
    // of the store to build the event, so the event *is* the only copy left.
    expect(store.pendingOutbox()).toHaveLength(1);
    expect(store.pendingOutbox()[0].event).toBe(event);

    store.settleOutbox('m-1');
    expect(useDesktopStore.getState().pendingOutbox()).toHaveLength(0);
  });

  it('an error naming a message fails it rather than leaving it queued forever', () => {
    const store = useDesktopStore.getState();
    store.trackMessage('m-1', 'sent');
    store.queueMessage('m-1', 3);
    expect(useDesktopStore.getState().messageStatuses['m-1'].status).toBe('queued');

    store.failMessage('m-1', 'Message queue is full');

    const status = useDesktopStore.getState().messageStatuses['m-1'];
    expect(status.status).toBe('failed');
    expect(status.error).toBe('Message queue is full');
    // "Queued at position 3" was a claim about a message that no longer exists.
    expect(status.position).toBeUndefined();
  });

  it('a message sent into a closed socket is marked unsent, not silently forgotten', () => {
    const store = useDesktopStore.getState();
    store.enqueueOutbox('m-1', event);
    store.trackMessage('m-1', 'unsent');

    expect(useDesktopStore.getState().messageStatuses['m-1'].status).toBe('unsent');
    expect(useDesktopStore.getState().pendingOutbox()).toHaveLength(1);
  });
});
