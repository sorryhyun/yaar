/**
 * Comprehensive tests for desktop store.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { useDesktopStore } from '../../store/desktop';
import {
  selectHasMaximizedWindow,
  selectVisibleWindows,
  selectWindowsInOrder,
} from '../../store/selectors';

// Window store keys are scoped by monitorId: "0/w1"
const key = (id: string) => `0/${id}`;

describe('Desktop Store', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      windows: {},
      zOrder: [],
      focusedWindowId: null,
      notifications: {},
      toasts: {},
      connectionStatus: 'disconnected',
      connectionError: null,
      activityLog: [],
      providerType: null,
      sessionId: null,
      activeMonitorId: '0',
    });
  });

  describe('Window Management', () => {
    it('creates windows with correct properties', () => {
      const { applyAction } = useDesktopStore.getState();

      applyAction({
        type: 'window.create',
        windowId: 'w1',
        title: 'Test Window',
        bounds: { x: 100, y: 100, w: 400, h: 300 },
        content: { renderer: 'markdown', data: '# Hello' },
      });

      const state = useDesktopStore.getState();
      expect(state.windows[key('w1')]).toMatchObject({
        id: key('w1'),
        title: 'Test Window',
        bounds: { x: 100, y: 100, w: 400, h: 300 },
        minimized: false,
        maximized: false,
      });
    });

    it('maintains z-order when creating multiple windows', () => {
      const { applyActions } = useDesktopStore.getState();

      applyActions([
        {
          type: 'window.create',
          windowId: 'w1',
          title: 'First',
          bounds: { x: 0, y: 0, w: 100, h: 100 },
          content: { renderer: 'text', data: '' },
        },
        {
          type: 'window.create',
          windowId: 'w2',
          title: 'Second',
          bounds: { x: 50, y: 50, w: 100, h: 100 },
          content: { renderer: 'text', data: '' },
        },
        {
          type: 'window.create',
          windowId: 'w3',
          title: 'Third',
          bounds: { x: 100, y: 100, w: 100, h: 100 },
          content: { renderer: 'text', data: '' },
        },
      ]);

      const state = useDesktopStore.getState();
      expect(state.zOrder).toEqual([key('w1'), key('w2'), key('w3')]);
      expect(state.focusedWindowId).toBe(key('w3'));
    });

    it('updates z-order on focus', () => {
      const { applyActions, applyAction } = useDesktopStore.getState();

      applyActions([
        {
          type: 'window.create',
          windowId: 'w1',
          title: 'First',
          bounds: { x: 0, y: 0, w: 100, h: 100 },
          content: { renderer: 'text', data: '' },
        },
        {
          type: 'window.create',
          windowId: 'w2',
          title: 'Second',
          bounds: { x: 50, y: 50, w: 100, h: 100 },
          content: { renderer: 'text', data: '' },
        },
      ]);

      applyAction({ type: 'window.focus', windowId: 'w1' });

      const state = useDesktopStore.getState();
      expect(state.zOrder).toEqual([key('w2'), key('w1')]);
      expect(state.focusedWindowId).toBe(key('w1'));
    });

    it('handles close correctly', () => {
      const { applyActions, applyAction } = useDesktopStore.getState();

      applyActions([
        {
          type: 'window.create',
          windowId: 'w1',
          title: 'First',
          bounds: { x: 0, y: 0, w: 100, h: 100 },
          content: { renderer: 'text', data: '' },
        },
        {
          type: 'window.create',
          windowId: 'w2',
          title: 'Second',
          bounds: { x: 50, y: 50, w: 100, h: 100 },
          content: { renderer: 'text', data: '' },
        },
      ]);

      applyAction({ type: 'window.close', windowId: 'w2' });

      const state = useDesktopStore.getState();
      expect(state.windows[key('w2')]).toBeUndefined();
      expect(state.zOrder).toEqual([key('w1')]);
      expect(state.focusedWindowId).toBe(key('w1'));
    });

    it('handles minimize/restore', () => {
      const { applyAction } = useDesktopStore.getState();

      applyAction({
        type: 'window.create',
        windowId: 'w1',
        title: 'Test',
        bounds: { x: 0, y: 0, w: 100, h: 100 },
        content: { renderer: 'text', data: '' },
      });

      applyAction({ type: 'window.minimize', windowId: 'w1' });
      expect(useDesktopStore.getState().windows[key('w1')].minimized).toBe(true);

      applyAction({ type: 'window.restore', windowId: 'w1' });
      expect(useDesktopStore.getState().windows[key('w1')].minimized).toBe(false);
    });

    it('handles maximize/restore with bounds preservation', () => {
      const { applyAction } = useDesktopStore.getState();
      const originalBounds = { x: 100, y: 100, w: 400, h: 300 };

      applyAction({
        type: 'window.create',
        windowId: 'w1',
        title: 'Test',
        bounds: originalBounds,
        content: { renderer: 'text', data: '' },
      });

      applyAction({ type: 'window.maximize', windowId: 'w1' });

      let state = useDesktopStore.getState();
      expect(state.windows[key('w1')].maximized).toBe(true);
      expect(state.windows[key('w1')].previousBounds).toEqual(originalBounds);

      applyAction({ type: 'window.restore', windowId: 'w1' });

      state = useDesktopStore.getState();
      expect(state.windows[key('w1')].maximized).toBe(false);
      expect(state.windows[key('w1')].bounds).toEqual(originalBounds);
    });

    it('scopes windows by monitorId to prevent cross-monitor collisions', () => {
      const { applyAction } = useDesktopStore.getState();

      // Create same windowId on two different monitors
      applyAction({
        type: 'window.create',
        windowId: 'win-storage',
        title: 'Storage (Monitor 0)',
        bounds: { x: 0, y: 0, w: 400, h: 300 },
        content: { renderer: 'markdown', data: '# Monitor 0' },
        monitorId: '0',
      } as Parameters<typeof applyAction>[0]);

      applyAction({
        type: 'window.create',
        windowId: 'win-storage',
        title: 'Storage (Monitor 1)',
        bounds: { x: 50, y: 50, w: 400, h: 300 },
        content: { renderer: 'markdown', data: '# Monitor 1' },
        monitorId: '1',
      } as Parameters<typeof applyAction>[0]);

      const state = useDesktopStore.getState();
      // Both windows should exist with different scoped keys
      expect(state.windows['0/win-storage']).toBeDefined();
      expect(state.windows['1/win-storage']).toBeDefined();
      expect(state.windows['0/win-storage'].title).toBe('Storage (Monitor 0)');
      expect(state.windows['1/win-storage'].title).toBe('Storage (Monitor 1)');
    });
  });

  describe('Selectors', () => {
    it('selectVisibleWindows excludes minimized', () => {
      const { applyActions, applyAction } = useDesktopStore.getState();

      applyActions([
        {
          type: 'window.create',
          windowId: 'w1',
          title: 'Visible',
          bounds: { x: 0, y: 0, w: 100, h: 100 },
          content: { renderer: 'text', data: '' },
        },
        {
          type: 'window.create',
          windowId: 'w2',
          title: 'Hidden',
          bounds: { x: 50, y: 50, w: 100, h: 100 },
          content: { renderer: 'text', data: '' },
        },
      ]);

      applyAction({ type: 'window.minimize', windowId: 'w2' });

      const visible = selectVisibleWindows(useDesktopStore.getState());
      expect(visible.length).toBe(1);
      expect(visible[0].id).toBe(key('w1'));
    });

    it('selectWindowsInOrder returns correct order', () => {
      const { applyActions } = useDesktopStore.getState();

      applyActions([
        {
          type: 'window.create',
          windowId: 'w1',
          title: 'First',
          bounds: { x: 0, y: 0, w: 100, h: 100 },
          content: { renderer: 'text', data: '' },
        },
        {
          type: 'window.create',
          windowId: 'w2',
          title: 'Second',
          bounds: { x: 50, y: 50, w: 100, h: 100 },
          content: { renderer: 'text', data: '' },
        },
        { type: 'window.focus', windowId: 'w1' },
      ]);

      const inOrder = selectWindowsInOrder(useDesktopStore.getState());
      expect(inOrder.map((w) => w.id)).toEqual([key('w2'), key('w1')]);
    });

    it('selectHasMaximizedWindow only matches visible fullscreen windows on the active monitor', () => {
      const { applyAction } = useDesktopStore.getState();

      applyAction({
        type: 'window.create',
        windowId: 'w1',
        title: 'Fullscreen',
        bounds: { x: 0, y: 0, w: 100, h: 100 },
        content: { renderer: 'text', data: '' },
        monitorId: '0',
      } as Parameters<typeof applyAction>[0]);
      applyAction({ type: 'window.maximize', windowId: 'w1' });

      expect(selectHasMaximizedWindow(useDesktopStore.getState())).toBe(true);

      useDesktopStore.setState({ activeMonitorId: '1' });
      expect(selectHasMaximizedWindow(useDesktopStore.getState())).toBe(false);

      useDesktopStore.setState({ activeMonitorId: '0' });
      applyAction({ type: 'window.minimize', windowId: 'w1' });
      expect(selectHasMaximizedWindow(useDesktopStore.getState())).toBe(false);
    });
  });

  describe('Toasts and Notifications', () => {
    it('adds and removes toasts', () => {
      const { applyAction, dismissToast } = useDesktopStore.getState();

      applyAction({
        type: 'toast.show',
        id: 't1',
        message: 'Hello!',
        variant: 'success',
      });

      expect(useDesktopStore.getState().toasts['t1']).toBeDefined();
      expect(useDesktopStore.getState().toasts['t1'].variant).toBe('success');

      dismissToast('t1');
      expect(useDesktopStore.getState().toasts['t1']).toBeUndefined();
    });

    it('adds and removes notifications', () => {
      const { applyAction, dismissNotification } = useDesktopStore.getState();

      applyAction({
        type: 'notification.show',
        id: 'n1',
        title: 'Alert',
        body: 'Something happened',
      });

      expect(useDesktopStore.getState().notifications['n1']).toBeDefined();

      dismissNotification('n1');
      expect(useDesktopStore.getState().notifications['n1']).toBeUndefined();
    });
  });

  describe('resetDesktop', () => {
    /** A session with work in flight on two monitors, plus one agent nothing can place. */
    function seedTwoMonitors() {
      useDesktopStore.setState({
        windows: {
          '1/w1': {
            id: '1/w1',
            title: 'One',
            bounds: { x: 0, y: 0, w: 100, h: 100 },
            content: { renderer: 'text', data: '' },
            minimized: false,
            maximized: false,
            monitorId: '1',
          },
          '2/w2': {
            id: '2/w2',
            title: 'Two',
            bounds: { x: 0, y: 0, w: 100, h: 100 },
            content: { renderer: 'text', data: '' },
            minimized: false,
            maximized: false,
            monitorId: '2',
          },
        },
        cliHistory: {
          '1': [
            {
              id: 'c1',
              type: 'user',
              content: 'on one',
              agentId: 'a1',
              monitorId: '1',
              timestamp: 1,
            },
          ],
          '2': [
            {
              id: 'c2',
              type: 'user',
              content: 'on two',
              agentId: 'a2',
              monitorId: '2',
              timestamp: 1,
            },
          ],
        },
        cliStreaming: {
          a1: {
            id: 's1',
            type: 'thinking',
            content: '...',
            agentId: 'a1',
            monitorId: '1',
            timestamp: 1,
          },
          a2: {
            id: 's2',
            type: 'thinking',
            content: '...',
            agentId: 'a2',
            monitorId: '2',
            timestamp: 1,
          },
        },
        activeAgents: {
          a1: {
            id: 'a1',
            status: 'Thinking...',
            startedAt: 1,
            statusSince: 1,
            subagentCount: 0,
            kind: 'monitor',
          },
          a2: {
            id: 'a2',
            status: 'Thinking...',
            startedAt: 1,
            statusSince: 1,
            subagentCount: 0,
            kind: 'monitor',
          },
          ghost: {
            id: 'ghost',
            status: 'Thinking...',
            startedAt: 1,
            statusSince: 1,
            subagentCount: 0,
            kind: 'monitor',
          },
        },
        windowAgents: {
          '1/w1': { agentId: 'a1', windowId: '1/w1', status: 'active' },
          '2/w2': { agentId: 'a2', windowId: '2/w2', status: 'active' },
        },
        queuedActions: {
          '1/w1': [{ windowId: '1/w1', windowTitle: 'One', action: 'go', queuedAt: 1 }],
          '2/w2': [{ windowId: '2/w2', windowTitle: 'Two', action: 'go', queuedAt: 1 }],
        },
        pendingFeedback: [
          { requestId: 'r1', windowId: '1/w1', renderer: 'text', success: true },
          { requestId: 'r2', windowId: '2/w2', renderer: 'text', success: true },
        ],
        pendingInteractions: [
          { type: 'icon.click', timestamp: 1, details: 'no window at all' },
          { type: 'window.focus', timestamp: 1, windowId: '2/w2' },
        ],
        pendingGestureMessages: ['a gesture nobody can attribute'],
        messageStatuses: {
          m1: { status: 'accepted', agentId: 'a1', timestamp: 1 },
          m2: { status: 'accepted', agentId: 'a2', timestamp: 1 },
          m3: { status: 'unsent', timestamp: 1 },
        },
        toasts: {
          t1: { id: 't1', message: 'still here', variant: 'info', timestamp: 1 },
        },
      });
    }

    it('scoped reset clears only the named monitor, and keeps what it cannot attribute', () => {
      seedTwoMonitors();

      useDesktopStore.getState().resetDesktop('2');
      const state = useDesktopStore.getState();

      // Monitor 1's transcript is the whole point: it survives intact.
      expect(state.cliHistory['1']).toHaveLength(1);
      expect(state.cliHistory['2']).toEqual([]);
      expect(state.cliStreaming.a1).toBeDefined();
      expect(state.cliStreaming.a2).toBeUndefined();

      // Agents: placed by the transcript / window binding, or left alone.
      expect(state.activeAgents.a1).toBeDefined();
      expect(state.activeAgents.a2).toBeUndefined();
      expect(state.activeAgents.ghost).toBeDefined();

      expect(Object.keys(state.windowAgents)).toEqual(['1/w1']);
      expect(Object.keys(state.queuedActions)).toEqual(['1/w1']);

      // Outbound queues are filtered, never emptied.
      expect(state.pendingFeedback.map((f) => f.windowId)).toEqual(['1/w1']);
      expect(state.pendingInteractions).toHaveLength(1);
      expect(state.pendingInteractions[0].details).toBe('no window at all');
      expect(state.pendingGestureMessages).toEqual(['a gesture nobody can attribute']);

      expect(state.messageStatuses.m1).toBeDefined();
      expect(state.messageStatuses.m2).toBeUndefined();
      expect(state.messageStatuses.m3).toBeDefined(); // no agent yet — unattributable

      // Neither branch touches the screen.
      expect(Object.keys(state.windows).sort()).toEqual(['1/w1', '2/w2']);
      expect(state.toasts.t1).toBeDefined();
    });

    it('unscoped reset still clears the whole session', () => {
      seedTwoMonitors();

      useDesktopStore.getState().resetDesktop();
      const state = useDesktopStore.getState();

      expect(state.cliHistory).toEqual({});
      expect(state.cliStreaming).toEqual({});
      expect(state.activeAgents).toEqual({});
      expect(state.windowAgents).toEqual({});
      expect(state.queuedActions).toEqual({});
      expect(state.pendingFeedback).toEqual([]);
      expect(state.pendingInteractions).toEqual([]);
      expect(state.pendingGestureMessages).toEqual([]);
      expect(state.messageStatuses).toEqual({});
      expect(state.toasts).toEqual({});
      expect(Object.keys(state.windows).sort()).toEqual(['1/w1', '2/w2']);
    });
  });
});
