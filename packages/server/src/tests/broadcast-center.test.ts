import { BroadcastCenter } from '../events/broadcast-center.js'
import type { ServerEvent } from '@yaar/shared'

/** Minimal mock of WebSocket */
function createMockWs(readyState = 1 /* OPEN */) {
  return {
    readyState,
    OPEN: 1,
    send: vi.fn(),
  } as unknown as import('ws').WebSocket
}

describe('BroadcastCenter', () => {
  let bc: BroadcastCenter

  beforeEach(() => {
    bc = new BroadcastCenter()
  })

  afterEach(() => {
    bc.clear()
  })

  const testEvent: ServerEvent = { type: 'AGENT_THINKING', content: 'thinking...' }

  describe('connection management', () => {
    it('subscribes and tracks connections', () => {
      bc.subscribe('c1', createMockWs())
      expect(bc.getStats().connectionCount).toBe(1)
    })

    it('unsubscribe removes connection and cleans up agents', () => {
      bc.subscribe('c1', createMockWs())
      bc.registerAgent('a1', 'c1')
      bc.registerAgent('a2', 'c1')

      bc.unsubscribe('c1')

      expect(bc.getStats().connectionCount).toBe(0)
      expect(bc.getStats().agentCount).toBe(0)
    })
  })

  describe('agent management', () => {
    it('registers and looks up agents', () => {
      bc.registerAgent('a1', 'c1')
      expect(bc.getConnectionForAgent('a1')).toBe('c1')
    })

    it('lists agents for a connection', () => {
      bc.registerAgent('a1', 'c1')
      bc.registerAgent('a2', 'c1')
      bc.registerAgent('a3', 'c2')

      expect(bc.getAgentsForConnection('c1')).toEqual(['a1', 'a2'])
    })

    it('unregisters agents', () => {
      bc.registerAgent('a1', 'c1')
      bc.unregisterAgent('a1')
      expect(bc.getConnectionForAgent('a1')).toBeUndefined()
    })
  })

  describe('publishing', () => {
    it('publishToConnection sends JSON', () => {
      const ws = createMockWs()
      bc.subscribe('c1', ws)

      const result = bc.publishToConnection(testEvent, 'c1')
      expect(result).toBe(true)
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify(testEvent))
    })

    it('returns false for missing connection', () => {
      expect(bc.publishToConnection(testEvent, 'nonexistent')).toBe(false)
    })

    it('returns false for closed connection', () => {
      bc.subscribe('c1', createMockWs(3 /* CLOSED */))
      expect(bc.publishToConnection(testEvent, 'c1')).toBe(false)
    })

    it('publishToAgent routes through agent→connection mapping', () => {
      const ws = createMockWs()
      bc.subscribe('c1', ws)
      bc.registerAgent('a1', 'c1')

      expect(bc.publishToAgent(testEvent, 'a1')).toBe(true)
      expect(ws.send).toHaveBeenCalled()
    })

    it('broadcast sends to all connections', () => {
      const ws1 = createMockWs()
      const ws2 = createMockWs()
      bc.subscribe('c1', ws1)
      bc.subscribe('c2', ws2)

      const count = bc.broadcast(testEvent)
      expect(count).toBe(2)
      expect(ws1.send).toHaveBeenCalled()
      expect(ws2.send).toHaveBeenCalled()
    })
  })

  it('clear removes everything', () => {
    bc.subscribe('c1', createMockWs())
    bc.registerAgent('a1', 'c1')
    bc.clear()
    expect(bc.getStats()).toEqual({ connectionCount: 0, agentCount: 0 })
  })
})
