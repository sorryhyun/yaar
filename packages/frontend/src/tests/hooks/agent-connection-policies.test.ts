import { describe, it, expect, vi } from 'vitest'
import { createWsManager, sendEvent, shouldReconnect } from '@/hooks/use-agent-connection/transport-manager'
import { dispatchServerEvent } from '@/hooks/use-agent-connection/server-event-dispatcher'

function createHandlers() {
  return {
    applyActions: vi.fn(),
    setIsConnecting: vi.fn(),
    setConnectionStatus: vi.fn(),
    setSession: vi.fn(),
    checkForPreviousSession: vi.fn(),
    addDebugEntry: vi.fn(),
    setAgentActive: vi.fn(),
    clearAgent: vi.fn(),
    registerWindowAgent: vi.fn(),
    updateWindowAgentStatus: vi.fn(),
    updateCliStreaming: vi.fn(),
    finalizeCliStreaming: vi.fn(),
    addCliEntry: vi.fn(),
  }
}

describe('transport manager', () => {
  it('sends only when socket is open', () => {
    const wsManager = createWsManager()
    const send = vi.fn()
    wsManager.ws = { readyState: WebSocket.OPEN, send } as unknown as WebSocket

    const ok = sendEvent(wsManager, { type: 'INTERRUPT' })
    expect(ok).toBe(true)
    expect(send).toHaveBeenCalledOnce()

    wsManager.ws = { readyState: WebSocket.CLOSED, send } as unknown as WebSocket
    expect(sendEvent(wsManager, { type: 'INTERRUPT' })).toBe(false)
  })

  it('computes reconnect eligibility', () => {
    expect(shouldReconnect(1006, 0)).toBe(true)
    expect(shouldReconnect(1000, 0)).toBe(false)
    expect(shouldReconnect(1006, 5)).toBe(false)
  })
})

describe('server event dispatcher', () => {
  it('dispatches connection and response events', () => {
    const handlers = createHandlers()

    dispatchServerEvent({ type: 'CONNECTION_STATUS', status: 'connected', provider: 'claude', sessionId: 's1' }, handlers)
    expect(handlers.setConnectionStatus).toHaveBeenCalledWith('connected', undefined)
    expect(handlers.setSession).toHaveBeenCalledWith('claude', 's1')

    dispatchServerEvent({ type: 'AGENT_RESPONSE', content: 'done', isComplete: true, agentId: 'a1' }, handlers)
    expect(handlers.clearAgent).toHaveBeenCalledWith('a1')
  })

  it('dispatches tool progress as active status updates', () => {
    const handlers = createHandlers()
    dispatchServerEvent({ type: 'TOOL_PROGRESS', toolName: 'search', status: 'running', agentId: 'a2' }, handlers)
    expect(handlers.setAgentActive).toHaveBeenCalledWith('a2', 'Running: search')

    dispatchServerEvent({ type: 'TOOL_PROGRESS', toolName: 'search', status: 'complete', agentId: 'a2' }, handlers)
    expect(handlers.setAgentActive).toHaveBeenCalledWith('a2', 'Thinking...')
  })
})
