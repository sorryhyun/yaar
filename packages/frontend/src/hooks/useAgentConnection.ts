/**
 * useAgentConnection - WebSocket connection to the agent backend.
 */
import { useEffect, useRef, useCallback, useState } from 'react'
import { useDesktopStore } from '@/store'
import type { ClientEvent, ServerEvent } from '@/types/events'

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000/ws'
const RECONNECT_DELAY = 3000
const MAX_RECONNECT_ATTEMPTS = 5

interface UseAgentConnectionOptions {
  autoConnect?: boolean
}

export function useAgentConnection(options: UseAgentConnectionOptions = {}) {
  const { autoConnect = true } = options

  const ws = useRef<WebSocket | null>(null)
  const reconnectAttempts = useRef(0)
  const reconnectTimeout = useRef<number | null>(null)

  const [isConnected, setIsConnected] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)

  const {
    applyActions,
    setConnectionStatus,
    setSession,
  } = useDesktopStore()

  // Handle incoming messages
  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const message = JSON.parse(event.data) as ServerEvent

      switch (message.type) {
        case 'ACTIONS':
          applyActions(message.actions)
          break

        case 'CONNECTION_STATUS':
          setConnectionStatus(
            message.status === 'connected' ? 'connected' :
            message.status === 'error' ? 'error' : 'disconnected',
            message.error
          )
          if (message.provider && message.sessionId) {
            setSession(message.provider, message.sessionId)
          }
          break

        case 'AGENT_THINKING':
          // Could update UI to show thinking indicator
          console.log('[Agent Thinking]', message.content)
          break

        case 'AGENT_RESPONSE':
          // Could stream response text to UI
          console.log('[Agent Response]', message.content)
          break

        case 'TOOL_PROGRESS':
          // Could show tool execution status
          console.log('[Tool]', message.toolName, message.status)
          break

        case 'REQUEST_PERMISSION':
          // Show permission dialog
          console.log('[Permission Request]', message.action, message.description)
          // TODO: Show modal and send permission response
          break

        case 'ERROR':
          console.error('[Agent Error]', message.error)
          setConnectionStatus('error', message.error)
          break
      }
    } catch (e) {
      console.error('Failed to parse message:', e)
    }
  }, [applyActions, setConnectionStatus, setSession])

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      return
    }

    setIsConnecting(true)
    setConnectionStatus('connecting')

    ws.current = new WebSocket(WS_URL)

    ws.current.onopen = () => {
      console.log('WebSocket connected')
      setIsConnected(true)
      setIsConnecting(false)
      setConnectionStatus('connected')
      reconnectAttempts.current = 0
    }

    ws.current.onmessage = handleMessage

    ws.current.onclose = (event) => {
      console.log('WebSocket closed:', event.code, event.reason)
      setIsConnected(false)
      setIsConnecting(false)
      setConnectionStatus('disconnected')
      ws.current = null

      // Auto-reconnect if not a clean close
      if (event.code !== 1000 && reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts.current++
        console.log(`Reconnecting in ${RECONNECT_DELAY}ms (attempt ${reconnectAttempts.current})`)
        reconnectTimeout.current = window.setTimeout(connect, RECONNECT_DELAY)
      }
    }

    ws.current.onerror = (error) => {
      console.error('WebSocket error:', error)
      setConnectionStatus('error', 'Connection failed')
    }
  }, [handleMessage, setConnectionStatus])

  // Disconnect
  const disconnect = useCallback(() => {
    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current)
      reconnectTimeout.current = null
    }
    reconnectAttempts.current = MAX_RECONNECT_ATTEMPTS // Prevent auto-reconnect

    if (ws.current) {
      ws.current.close(1000, 'User disconnect')
      ws.current = null
    }

    setIsConnected(false)
    setConnectionStatus('disconnected')
  }, [setConnectionStatus])

  // Send message
  const send = useCallback((event: ClientEvent) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(event))
    } else {
      console.warn('WebSocket not connected, cannot send:', event)
    }
  }, [])

  // Send user message
  const sendMessage = useCallback((content: string) => {
    send({ type: 'USER_MESSAGE', content })
  }, [send])

  // Interrupt current operation
  const interrupt = useCallback(() => {
    send({ type: 'INTERRUPT' })
  }, [send])

  // Set provider
  const setProvider = useCallback((provider: 'claude' | 'codex') => {
    send({ type: 'SET_PROVIDER', provider })
  }, [send])

  // Auto-connect on mount
  useEffect(() => {
    if (autoConnect) {
      connect()
    }

    return () => {
      disconnect()
    }
  }, [autoConnect, connect, disconnect])

  return {
    isConnected,
    isConnecting,
    connect,
    disconnect,
    sendMessage,
    interrupt,
    setProvider,
  }
}
