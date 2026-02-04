import {
  componentSchema,
  componentLayoutSchema,
  displayContentSchema,
  isComponent,
  isButtonComponent,
  isTextComponent,
  isBadgeComponent,
  isProgressComponent,
  isImageComponent,
  isInputComponent,
  isSelectComponent,
} from '../components.js'

describe('Zod Schemas', () => {
  describe('componentSchema', () => {
    it('parses a valid button', () => {
      const result = componentSchema.safeParse({ type: 'button', label: 'Click', action: 'do_thing' })
      expect(result.success).toBe(true)
    })

    it('parses a valid text component', () => {
      const result = componentSchema.safeParse({ type: 'text', content: 'Hello' })
      expect(result.success).toBe(true)
    })

    it('parses a valid progress component', () => {
      const result = componentSchema.safeParse({ type: 'progress', value: 50 })
      expect(result.success).toBe(true)
    })

    it('rejects unknown type', () => {
      const result = componentSchema.safeParse({ type: 'unknown_widget' })
      expect(result.success).toBe(false)
    })

    it('rejects progress value out of range', () => {
      const result = componentSchema.safeParse({ type: 'progress', value: 150 })
      expect(result.success).toBe(false)
    })
  })

  describe('componentLayoutSchema', () => {
    it('parses layout with components', () => {
      const result = componentLayoutSchema.safeParse({
        components: [{ type: 'button', label: 'OK', action: 'confirm' }],
        cols: 2,
        gap: 'md',
      })
      expect(result.success).toBe(true)
    })

    it('accepts ratio columns', () => {
      const result = componentLayoutSchema.safeParse({
        components: [],
        cols: [8, 2],
      })
      expect(result.success).toBe(true)
    })

    it('accepts minimal layout', () => {
      const result = componentLayoutSchema.safeParse({ components: [] })
      expect(result.success).toBe(true)
    })
  })

  describe('displayContentSchema', () => {
    it('parses markdown content', () => {
      const result = displayContentSchema.safeParse({ renderer: 'markdown', content: '# Title' })
      expect(result.success).toBe(true)
    })

    it('rejects invalid renderer', () => {
      const result = displayContentSchema.safeParse({ renderer: 'unknown', content: '' })
      expect(result.success).toBe(false)
    })
  })
})

describe('Component Type Guards', () => {
  const button = { type: 'button' as const, label: 'Click', action: 'do' }
  const text = { type: 'text' as const, content: 'Hello' }
  const badge = { type: 'badge' as const, label: 'New' }
  const progress = { type: 'progress' as const, value: 50 }
  const image = { type: 'image' as const, src: '/img.png' }
  const input = { type: 'input' as const, name: 'field' }
  const select = { type: 'select' as const, name: 'opt', options: [{ value: 'a', label: 'A' }] }

  it('isComponent detects component objects', () => {
    expect(isComponent(button)).toBe(true)
    expect(isComponent(null)).toBe(false)
    expect(isComponent('string')).toBe(false)
  })

  it('each type guard matches only its type', () => {
    expect(isButtonComponent(button)).toBe(true)
    expect(isButtonComponent(text)).toBe(false)

    expect(isTextComponent(text)).toBe(true)
    expect(isBadgeComponent(badge)).toBe(true)
    expect(isProgressComponent(progress)).toBe(true)
    expect(isImageComponent(image)).toBe(true)
    expect(isInputComponent(input)).toBe(true)
    expect(isSelectComponent(select)).toBe(true)
  })
})
