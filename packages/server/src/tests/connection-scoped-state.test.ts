import { windowStateRegistryManager } from '../mcp/window-state.js'
import { reloadCacheManager } from '../reload/index.js'
import type { Fingerprint } from '../reload/types.js'
import type { OSAction } from '@yaar/shared'

describe('connection-scoped state', () => {
  const connA = 'conn-a'
  const connB = 'conn-b'

  afterEach(() => {
    windowStateRegistryManager.clearAll()
    reloadCacheManager.clearAll()
  })

  it('isolates window state across two connections', () => {
    const stateA = windowStateRegistryManager.get(connA)
    const stateB = windowStateRegistryManager.get(connB)

    stateA.handleAction({
      type: 'window.create',
      windowId: 'a-win',
      title: 'A Window',
      bounds: { x: 0, y: 0, w: 400, h: 300 },
      content: { renderer: 'markdown', data: 'A' },
    })

    stateB.handleAction({
      type: 'window.create',
      windowId: 'b-win',
      title: 'B Window',
      bounds: { x: 10, y: 10, w: 400, h: 300 },
      content: { renderer: 'markdown', data: 'B' },
    })

    expect(stateA.hasWindow('a-win')).toBe(true)
    expect(stateA.hasWindow('b-win')).toBe(false)
    expect(stateB.hasWindow('b-win')).toBe(true)
    expect(stateB.hasWindow('a-win')).toBe(false)
  })

  it('isolates reload cache entries across two connections', () => {
    const cacheA = reloadCacheManager.get(connA)
    const cacheB = reloadCacheManager.get(connB)

    const fingerprint: Fingerprint = {
      triggerType: 'main',
      ngrams: ['open', 'app'],
      contentHash: 'same-content',
      windowStateHash: 'same-windows',
    }

    const actions: OSAction[] = [
      {
        type: 'window.create',
        windowId: 'shared-window-id',
        title: 'Shared',
        bounds: { x: 0, y: 0, w: 200, h: 200 },
        content: { renderer: 'markdown', data: 'hello' },
      },
    ]

    cacheA.record(fingerprint, actions, 'entry A')
    cacheB.record(fingerprint, actions, 'entry B')

    expect(cacheA.listEntries()).toHaveLength(1)
    expect(cacheB.listEntries()).toHaveLength(1)
    expect(cacheA.listEntries()[0]?.label).toBe('entry A')
    expect(cacheB.listEntries()[0]?.label).toBe('entry B')
  })

  it('clearing one connection does not clear the other', () => {
    const stateA = windowStateRegistryManager.get(connA)
    const stateB = windowStateRegistryManager.get(connB)
    const cacheA = reloadCacheManager.get(connA)
    const cacheB = reloadCacheManager.get(connB)

    stateA.handleAction({
      type: 'window.create',
      windowId: 'a-win',
      title: 'A Window',
      bounds: { x: 0, y: 0, w: 400, h: 300 },
      content: { renderer: 'markdown', data: 'A' },
    })
    stateB.handleAction({
      type: 'window.create',
      windowId: 'b-win',
      title: 'B Window',
      bounds: { x: 10, y: 10, w: 400, h: 300 },
      content: { renderer: 'markdown', data: 'B' },
    })

    cacheA.record(
      { triggerType: 'main', ngrams: ['a'], contentHash: 'a', windowStateHash: 'a' },
      [],
      'A only'
    )
    cacheB.record(
      { triggerType: 'main', ngrams: ['b'], contentHash: 'b', windowStateHash: 'b' },
      [],
      'B only'
    )

    windowStateRegistryManager.clear(connA)
    reloadCacheManager.clear(connA)

    expect(windowStateRegistryManager.get(connA).listWindows()).toHaveLength(0)
    expect(windowStateRegistryManager.get(connB).listWindows()).toHaveLength(1)
    expect(reloadCacheManager.get(connA).listEntries()).toHaveLength(0)
    expect(reloadCacheManager.get(connB).listEntries()).toHaveLength(1)
  })
})
