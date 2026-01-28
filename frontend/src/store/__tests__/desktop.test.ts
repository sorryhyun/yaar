/**
 * Comprehensive tests for desktop store.
 */
import { useDesktopStore, selectVisibleWindows, selectWindowsInOrder } from '../desktop'
import type { OSAction } from '@/types/actions'

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
    })
  })

  describe('Window Management', () => {
    it('creates windows with correct properties', () => {
      const { applyAction } = useDesktopStore.getState()

      applyAction({
        type: 'window.create',
        windowId: 'w1',
        title: 'Test Window',
        bounds: { x: 100, y: 100, w: 400, h: 300 },
        content: { renderer: 'markdown', data: '# Hello' },
      })

      const state = useDesktopStore.getState()
      expect(state.windows['w1']).toMatchObject({
        id: 'w1',
        title: 'Test Window',
        bounds: { x: 100, y: 100, w: 400, h: 300 },
        minimized: false,
        maximized: false,
      })
    })

    it('maintains z-order when creating multiple windows', () => {
      const { applyActions } = useDesktopStore.getState()

      applyActions([
        { type: 'window.create', windowId: 'w1', title: 'First', bounds: { x: 0, y: 0, w: 100, h: 100 }, content: { renderer: 'text', data: '' } },
        { type: 'window.create', windowId: 'w2', title: 'Second', bounds: { x: 50, y: 50, w: 100, h: 100 }, content: { renderer: 'text', data: '' } },
        { type: 'window.create', windowId: 'w3', title: 'Third', bounds: { x: 100, y: 100, w: 100, h: 100 }, content: { renderer: 'text', data: '' } },
      ])

      const state = useDesktopStore.getState()
      expect(state.zOrder).toEqual(['w1', 'w2', 'w3'])
      expect(state.focusedWindowId).toBe('w3')
    })

    it('updates z-order on focus', () => {
      const { applyActions, applyAction } = useDesktopStore.getState()

      applyActions([
        { type: 'window.create', windowId: 'w1', title: 'First', bounds: { x: 0, y: 0, w: 100, h: 100 }, content: { renderer: 'text', data: '' } },
        { type: 'window.create', windowId: 'w2', title: 'Second', bounds: { x: 50, y: 50, w: 100, h: 100 }, content: { renderer: 'text', data: '' } },
      ])

      applyAction({ type: 'window.focus', windowId: 'w1' })

      const state = useDesktopStore.getState()
      expect(state.zOrder).toEqual(['w2', 'w1'])
      expect(state.focusedWindowId).toBe('w1')
    })

    it('handles close correctly', () => {
      const { applyActions, applyAction } = useDesktopStore.getState()

      applyActions([
        { type: 'window.create', windowId: 'w1', title: 'First', bounds: { x: 0, y: 0, w: 100, h: 100 }, content: { renderer: 'text', data: '' } },
        { type: 'window.create', windowId: 'w2', title: 'Second', bounds: { x: 50, y: 50, w: 100, h: 100 }, content: { renderer: 'text', data: '' } },
      ])

      applyAction({ type: 'window.close', windowId: 'w2' })

      const state = useDesktopStore.getState()
      expect(state.windows['w2']).toBeUndefined()
      expect(state.zOrder).toEqual(['w1'])
      expect(state.focusedWindowId).toBe('w1')
    })

    it('handles minimize/restore', () => {
      const { applyAction } = useDesktopStore.getState()

      applyAction({
        type: 'window.create',
        windowId: 'w1',
        title: 'Test',
        bounds: { x: 0, y: 0, w: 100, h: 100 },
        content: { renderer: 'text', data: '' },
      })

      applyAction({ type: 'window.minimize', windowId: 'w1' })
      expect(useDesktopStore.getState().windows['w1'].minimized).toBe(true)

      applyAction({ type: 'window.restore', windowId: 'w1' })
      expect(useDesktopStore.getState().windows['w1'].minimized).toBe(false)
    })

    it('handles maximize/restore with bounds preservation', () => {
      const { applyAction } = useDesktopStore.getState()
      const originalBounds = { x: 100, y: 100, w: 400, h: 300 }

      applyAction({
        type: 'window.create',
        windowId: 'w1',
        title: 'Test',
        bounds: originalBounds,
        content: { renderer: 'text', data: '' },
      })

      applyAction({ type: 'window.maximize', windowId: 'w1' })

      let state = useDesktopStore.getState()
      expect(state.windows['w1'].maximized).toBe(true)
      expect(state.windows['w1'].previousBounds).toEqual(originalBounds)

      applyAction({ type: 'window.restore', windowId: 'w1' })

      state = useDesktopStore.getState()
      expect(state.windows['w1'].maximized).toBe(false)
      expect(state.windows['w1'].bounds).toEqual(originalBounds)
    })
  })

  describe('Selectors', () => {
    it('selectVisibleWindows excludes minimized', () => {
      const { applyActions, applyAction } = useDesktopStore.getState()

      applyActions([
        { type: 'window.create', windowId: 'w1', title: 'Visible', bounds: { x: 0, y: 0, w: 100, h: 100 }, content: { renderer: 'text', data: '' } },
        { type: 'window.create', windowId: 'w2', title: 'Hidden', bounds: { x: 50, y: 50, w: 100, h: 100 }, content: { renderer: 'text', data: '' } },
      ])

      applyAction({ type: 'window.minimize', windowId: 'w2' })

      const visible = selectVisibleWindows(useDesktopStore.getState())
      expect(visible.length).toBe(1)
      expect(visible[0].id).toBe('w1')
    })

    it('selectWindowsInOrder returns correct order', () => {
      const { applyActions } = useDesktopStore.getState()

      applyActions([
        { type: 'window.create', windowId: 'w1', title: 'First', bounds: { x: 0, y: 0, w: 100, h: 100 }, content: { renderer: 'text', data: '' } },
        { type: 'window.create', windowId: 'w2', title: 'Second', bounds: { x: 50, y: 50, w: 100, h: 100 }, content: { renderer: 'text', data: '' } },
        { type: 'window.focus', windowId: 'w1' },
      ])

      const inOrder = selectWindowsInOrder(useDesktopStore.getState())
      expect(inOrder.map(w => w.id)).toEqual(['w2', 'w1'])
    })
  })

  describe('Toasts and Notifications', () => {
    it('adds and removes toasts', () => {
      const { applyAction, dismissToast } = useDesktopStore.getState()

      applyAction({
        type: 'toast.show',
        id: 't1',
        message: 'Hello!',
        variant: 'success',
      })

      expect(useDesktopStore.getState().toasts['t1']).toBeDefined()
      expect(useDesktopStore.getState().toasts['t1'].variant).toBe('success')

      dismissToast('t1')
      expect(useDesktopStore.getState().toasts['t1']).toBeUndefined()
    })

    it('adds and removes notifications', () => {
      const { applyAction, dismissNotification } = useDesktopStore.getState()

      applyAction({
        type: 'notification.show',
        id: 'n1',
        title: 'Alert',
        body: 'Something happened',
      })

      expect(useDesktopStore.getState().notifications['n1']).toBeDefined()

      dismissNotification('n1')
      expect(useDesktopStore.getState().notifications['n1']).toBeUndefined()
    })
  })
})
