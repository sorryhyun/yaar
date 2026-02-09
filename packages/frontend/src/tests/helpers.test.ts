import { emptyContentByRenderer } from '../store/helpers'

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
