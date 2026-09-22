/**
 * The Android notification bridge: what reaches the shade, and when it leaves.
 *
 * Two rules carry the whole feature, and both are about restraint. Nothing is posted while
 * a person is looking at the desktop — the shade would only repeat the screen — and
 * everything posted comes down once they look again. The Termux client is a recorder, so
 * nothing here spawns a process.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { ServerEventType, type OSAction, type ServerEvent } from '@yaar/shared';
import type { TermuxNotification } from '@yaar/lib/termux';
import { NativeNotificationBridge, excerpt } from '../features/android/native-notifications.js';

const SESSION = 'ses-1';

let watching: boolean;
let posted: TermuxNotification[];
let removed: string[];
let bridge: NativeNotificationBridge;

beforeEach(() => {
  watching = false;
  posted = [];
  removed = [];
  bridge = new NativeNotificationBridge({
    termux: {
      notify: async (n) => {
        posted.push(n);
        return true;
      },
      removeNotification: async (id) => {
        removed.push(id);
      },
    },
    isUserWatching: () => watching,
    desktopUrl: () => 'http://localhost:8000/',
  });
});

const actions = (...list: OSAction[]): ServerEvent =>
  ({ type: ServerEventType.ACTIONS, actions: list, agentId: 'monitor-0' }) as ServerEvent;

const response = (agentId: string, content: string): ServerEvent =>
  ({
    type: ServerEventType.AGENT_RESPONSE,
    content,
    isComplete: true,
    agentId,
    monitorId: '0',
  }) as ServerEvent;

describe('NativeNotificationBridge', () => {
  it('mirrors an agent notification while nobody is looking, with a tap that opens the desktop', () => {
    bridge.handle(
      SESSION,
      actions({ type: 'notification.show', id: 'a', title: 'Build done', body: 'All green' }),
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ title: 'Build done', content: 'All green', group: 'yaar' });
    expect(posted[0].action).toBe("termux-open-url 'http://localhost:8000/'");
  });

  it('posts nothing while the user is watching', () => {
    watching = true;
    bridge.handle(
      SESSION,
      actions({ type: 'dialog.confirm', id: 'd1', title: 'Run tool', message: 'May I?' }),
    );
    expect(posted).toHaveLength(0);
  });

  it('raises approvals and questions at high priority', () => {
    bridge.handle(
      SESSION,
      actions({ type: 'dialog.confirm', id: 'd1', title: 'Run tool', message: 'May I?' }, {
        type: 'user.prompt.show',
        id: 'p1',
        title: 'Pick one',
        message: 'A or B?',
      } as OSAction),
    );
    expect(posted.map((n) => [n.title, n.priority])).toEqual([
      ['Approval needed: Run tool', 'high'],
      ['Question: Pick one', 'high'],
    ]);
  });

  it('takes a dialog down when the server withdraws it', () => {
    bridge.handle(SESSION, actions({ type: 'dialog.confirm', id: 'd1', title: 'T', message: 'M' }));
    bridge.handle(SESSION, actions({ type: 'dialog.close', id: 'd1', reason: 'timeout' }));
    expect(removed).toEqual([posted[0].id]);
  });

  it('says a monitor turn finished, once — the empty closing event is ignored', () => {
    bridge.handle(SESSION, response('monitor-0-msg1', 'Here is **your** summary.'));
    bridge.handle(SESSION, response('monitor-0-msg1', ''));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ title: 'YAAR finished', content: 'Here is your summary.' });
  });

  it('does not announce app-agent turns the user did not start', () => {
    bridge.handle(SESSION, response('app-notes-m0-x', 'Saved.'));
    expect(posted).toHaveLength(0);
  });

  it('clears everything it posted when the user comes back, and nothing before', () => {
    bridge.handle(SESSION, actions({ type: 'notification.show', id: 'a', title: 'A', body: '' }));
    bridge.handle(SESSION, response('monitor-0-m', 'done'));

    bridge.presenceChanged(SESSION); // still away
    expect(removed).toEqual([]);

    watching = true;
    bridge.presenceChanged(SESSION);
    expect(removed.sort()).toEqual(posted.map((n) => n.id).sort());

    bridge.presenceChanged(SESSION); // nothing left to clear
    expect(removed).toHaveLength(2);
  });

  it('keeps two sessions’ notifications with the same local id apart', () => {
    const show = actions({ type: 'notification.show', id: 'same', title: 'X', body: '' });
    bridge.handle('ses-a', show);
    bridge.handle('ses-b', show);
    expect(new Set(posted.map((n) => n.id)).size).toBe(2);
  });
});

describe('excerpt', () => {
  it('flattens markdown and code, and caps the length', () => {
    expect(excerpt('# Title\n\n```ts\nconst x = 1;\n```\n*done*')).toBe('Title done');
    expect(excerpt('x'.repeat(500)).length).toBe(240);
  });
});
