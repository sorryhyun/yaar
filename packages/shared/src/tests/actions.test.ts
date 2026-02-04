import {
  isWindowAction,
  isNotificationAction,
  isToastAction,
  isDialogAction,
  isTableContentData,
  isIframeContentData,
  isComponentLayout,
  isWindowContentData,
  isContentUpdateOperationValid,
  WINDOW_PRESETS,
  type OSAction,
} from '../actions.js'

describe('Type Guards', () => {
  const windowAction: OSAction = { type: 'window.create', windowId: 'w1', title: 'T', bounds: { x: 0, y: 0, w: 100, h: 100 }, content: { renderer: 'text', data: '' } }
  const notifAction: OSAction = { type: 'notification.show', id: 'n1', title: 'T', body: 'B' }
  const toastAction: OSAction = { type: 'toast.show', id: 't1', message: 'M' }
  const dialogAction: OSAction = { type: 'dialog.confirm', id: 'd1', title: 'T', message: 'M' }

  it('isWindowAction', () => {
    expect(isWindowAction(windowAction)).toBe(true)
    expect(isWindowAction(notifAction)).toBe(false)
  })

  it('isNotificationAction', () => {
    expect(isNotificationAction(notifAction)).toBe(true)
    expect(isNotificationAction(windowAction)).toBe(false)
  })

  it('isToastAction', () => {
    expect(isToastAction(toastAction)).toBe(true)
    expect(isToastAction(windowAction)).toBe(false)
  })

  it('isDialogAction', () => {
    expect(isDialogAction(dialogAction)).toBe(true)
    expect(isDialogAction(windowAction)).toBe(false)
  })
})

describe('Runtime Validation', () => {
  describe('isTableContentData', () => {
    it('accepts valid table data', () => {
      expect(isTableContentData({ headers: ['A', 'B'], rows: [['1', '2']] })).toBe(true)
    })

    it('accepts empty table', () => {
      expect(isTableContentData({ headers: [], rows: [] })).toBe(true)
    })

    it('rejects invalid inputs', () => {
      expect(isTableContentData(null)).toBe(false)
      expect(isTableContentData('string')).toBe(false)
      expect(isTableContentData({ headers: [1], rows: [] })).toBe(false)
      expect(isTableContentData({ headers: [], rows: [[1]] })).toBe(false)
    })
  })

  describe('isIframeContentData', () => {
    it('accepts string URL', () => {
      expect(isIframeContentData('https://example.com')).toBe(true)
    })

    it('accepts object with url', () => {
      expect(isIframeContentData({ url: 'https://example.com' })).toBe(true)
      expect(isIframeContentData({ url: 'https://example.com', sandbox: 'allow-scripts' })).toBe(true)
    })

    it('rejects invalid inputs', () => {
      expect(isIframeContentData(null)).toBe(false)
      expect(isIframeContentData(42)).toBe(false)
      expect(isIframeContentData({ url: 123 })).toBe(false)
    })
  })

  describe('isComponentLayout', () => {
    it('accepts valid layout', () => {
      expect(isComponentLayout({ components: [] })).toBe(true)
      expect(isComponentLayout({ components: [{ type: 'button' }] })).toBe(true)
    })

    it('rejects invalid inputs', () => {
      expect(isComponentLayout(null)).toBe(false)
      expect(isComponentLayout({})).toBe(false)
      expect(isComponentLayout({ components: 'not-array' })).toBe(false)
    })
  })

  describe('isWindowContentData', () => {
    it('validates string renderers', () => {
      expect(isWindowContentData('markdown', '# Hello')).toBe(true)
      expect(isWindowContentData('html', '<p>Hi</p>')).toBe(true)
      expect(isWindowContentData('text', 'plain')).toBe(true)
      expect(isWindowContentData('markdown', 42)).toBe(false)
    })

    it('validates table renderer', () => {
      expect(isWindowContentData('table', { headers: ['A'], rows: [['1']] })).toBe(true)
      expect(isWindowContentData('table', 'not-table')).toBe(false)
    })

    it('validates iframe renderer', () => {
      expect(isWindowContentData('iframe', 'https://example.com')).toBe(true)
      expect(isWindowContentData('iframe', null)).toBe(false)
    })

    it('validates component renderer', () => {
      expect(isWindowContentData('component', { components: [] })).toBe(true)
      expect(isWindowContentData('component', 'string')).toBe(false)
    })

    it('unknown renderer accepts anything defined', () => {
      expect(isWindowContentData('custom', 'anything')).toBe(true)
      expect(isWindowContentData('custom', undefined)).toBe(false)
    })
  })

  describe('isContentUpdateOperationValid', () => {
    it('validates append/prepend for text renderers', () => {
      expect(isContentUpdateOperationValid('markdown', { op: 'append', data: 'more' })).toBe(true)
      expect(isContentUpdateOperationValid('html', { op: 'prepend', data: '<p>' })).toBe(true)
      expect(isContentUpdateOperationValid('table', { op: 'append', data: 'nope' })).toBe(false)
      expect(isContentUpdateOperationValid('markdown', { op: 'append', data: 42 })).toBe(false)
    })

    it('validates insertAt', () => {
      expect(isContentUpdateOperationValid('text', { op: 'insertAt', position: 5, data: 'x' })).toBe(true)
      expect(isContentUpdateOperationValid('text', { op: 'insertAt', position: Infinity, data: 'x' })).toBe(false)
    })

    it('validates replace', () => {
      expect(isContentUpdateOperationValid('markdown', { op: 'replace', data: 'new' })).toBe(true)
      expect(isContentUpdateOperationValid('table', { op: 'replace', data: { headers: [], rows: [] } })).toBe(true)
    })

    it('clear always valid', () => {
      expect(isContentUpdateOperationValid('markdown', { op: 'clear' })).toBe(true)
      expect(isContentUpdateOperationValid('table', { op: 'clear' })).toBe(true)
    })
  })
})

describe('WINDOW_PRESETS', () => {
  it('has all expected presets', () => {
    expect(Object.keys(WINDOW_PRESETS)).toEqual(
      expect.arrayContaining(['default', 'info', 'alert', 'document', 'sidebar', 'dialog'])
    )
  })

  it('each preset has width and height', () => {
    for (const preset of Object.values(WINDOW_PRESETS)) {
      expect(preset.width).toBeGreaterThan(0)
      expect(preset.height).toBeGreaterThan(0)
    }
  })
})
