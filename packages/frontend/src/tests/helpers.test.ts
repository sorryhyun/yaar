import { consolidateInteractions, emptyContentByRenderer } from '../store/helpers'

describe('consolidateInteractions', () => {
  it('returns empty for empty input', () => {
    expect(consolidateInteractions([])).toEqual([])
  })

  it('passes through non-move/resize events unchanged', () => {
    const events = [
      { type: 'window.close' as const, timestamp: 1, windowId: 'w1' },
      { type: 'window.focus' as const, timestamp: 2, windowId: 'w1' },
    ]
    expect(consolidateInteractions(events)).toEqual(events)
  })

  it('consolidates consecutive move events for same window', () => {
    const events = [
      { type: 'window.move' as const, timestamp: 1, windowId: 'w1', details: 'moved to (0, 0)' },
      { type: 'window.move' as const, timestamp: 2, windowId: 'w1', details: 'moved to (50, 50)' },
      { type: 'window.move' as const, timestamp: 3, windowId: 'w1', details: 'moved to (100, 100)' },
    ]
    const result = consolidateInteractions(events)
    expect(result).toHaveLength(1)
    expect(result[0].details).toContain('from (0, 0)')
    expect(result[0].details).toContain('to (100, 100)')
  })

  it('does not consolidate moves for different windows', () => {
    const events = [
      { type: 'window.move' as const, timestamp: 1, windowId: 'w1', details: 'moved to (0, 0)' },
      { type: 'window.move' as const, timestamp: 2, windowId: 'w2', details: 'moved to (50, 50)' },
    ]
    expect(consolidateInteractions(events)).toHaveLength(2)
  })

  it('keeps single move event as-is', () => {
    const events = [
      { type: 'window.move' as const, timestamp: 1, windowId: 'w1', details: 'moved to (10, 20)' },
    ]
    expect(consolidateInteractions(events)).toEqual(events)
  })
})

describe('emptyContentByRenderer', () => {
  it('returns empty string for text-based renderers', () => {
    expect(emptyContentByRenderer('markdown')).toBe('')
    expect(emptyContentByRenderer('html')).toBe('')
    expect(emptyContentByRenderer('text')).toBe('')
  })

  it('returns empty table for table renderer', () => {
    expect(emptyContentByRenderer('table')).toEqual({ headers: [], rows: [] })
  })

  it('returns null for unknown renderer', () => {
    expect(emptyContentByRenderer('custom')).toBeNull()
  })
})
