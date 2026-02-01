/**
 * useAgentConnection - WebSocket connection to the agent backend.
 * Uses a singleton pattern to share the WebSocket across all components.
 */
import { useEffect, useCallback, useState, useSyncExternalStore } from 'react'
import { useDesktopStore } from '@/store'
import type { ClientEvent, ServerEvent } from '@/types'

// Use relative URL for production (same host as page)
// In development, Vite proxy handles /ws, so we can use relative path
const WS_URL = import.meta.env.VITE_WS_URL ||
  (typeof window !== 'undefined'
    ? `ws://${window.location.host}/ws`
    : 'ws://localhost:8000/ws')
const RECONNECT_DELAY = 3000
const MAX_RECONNECT_ATTEMPTS = 5

// Singleton WebSocket manager
const wsManager = {
  ws: null as WebSocket | null,
  reconnectAttempts: 0,
  reconnectTimeout: null as number | null,
  listeners: new Set<() => void>(),

  getSnapshot() {
    return this.ws?.readyState === WebSocket.OPEN
  },

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  },

  notify() {
    this.listeners.forEach(l => l())
  },

  getSocket() {
    return this.ws
  }
}

interface UseAgentConnectionOptions {
  autoConnect?: boolean
}

export function useAgentConnection(options: UseAgentConnectionOptions = {}) {
  const { autoConnect = true } = options

  // Use external store for connection state to share across all hook instances
  const isConnected = useSyncExternalStore(
    (cb) => wsManager.subscribe(cb),
    () => wsManager.getSnapshot(),
    () => false
  )
  const [isConnecting, setIsConnecting] = useState(false)

  const {
    applyActions,
    setConnectionStatus,
    setSession,
    addDebugEntry,
    setAgentActive,
    clearAgent,
    clearAllAgents,
    consumePendingFeedback,
    consumeInteractions,
    consumeDrawing,
    registerWindowAgent,
    updateWindowAgentStatus,
    setRestorePrompt,
  } = useDesktopStore()

  // Check for previous session to restore
  const checkForPreviousSession = useCallback(async (currentSessionId: string) => {
    try {
      const response = await fetch('/api/sessions')
      if (!response.ok) return

      const data = await response.json()
      const sessions = data.sessions || []

      // Find sessions that are not the current one
      const previousSessions = sessions.filter(
        (s: { sessionId: string }) => s.sessionId !== currentSessionId
      )

      // If there's a recent session, offer to restore it
      if (previousSessions.length > 0) {
        const lastSession = previousSessions[0]
        setRestorePrompt({
          sessionId: lastSession.sessionId,
          sessionDate: lastSession.metadata?.createdAt || new Date().toISOString()
        })
      }
    } catch (err) {
      console.error('Failed to check for previous sessions:', err)
    }
  }, [setRestorePrompt])

  // Handle incoming messages
  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const message = JSON.parse(event.data) as ServerEvent

      // Only log significant events to debug panel (skip streaming chunks)
      const shouldLog =
        message.type === 'ACTIONS' ||
        message.type === 'CONNECTION_STATUS' ||
        message.type === 'ERROR' ||
        (message.type === 'AGENT_RESPONSE' && (message as { isComplete?: boolean }).isComplete) ||
        (message.type === 'TOOL_PROGRESS' && (message as { status?: string }).status !== 'running')

      if (shouldLog) {
        addDebugEntry({
          direction: 'in',
          type: message.type,
          data: message,
        })
      }

      switch (message.type) {
        case 'ACTIONS':
          applyActions(message.actions)
          break

        case 'CONNECTION_STATUS':
          // Agent is ready - update connection status
          setIsConnecting(false)
          setConnectionStatus(
            message.status === 'connected' ? 'connected' :
            message.status === 'error' ? 'error' : 'disconnected',
            message.error
          )
          if (message.provider && message.sessionId) {
            setSession(message.provider, message.sessionId)
            // Check for previous sessions to restore
            checkForPreviousSession(message.sessionId)
          }
          break

        case 'AGENT_THINKING': {
          const agentId = (message as { agentId?: string }).agentId || 'default'
          setAgentActive(agentId, 'Thinking...')
          break
        }

        case 'AGENT_RESPONSE': {
          const agentId = (message as { agentId?: string }).agentId || 'default'
          const isComplete = (message as { isComplete?: boolean }).isComplete
          if (isComplete) {
            clearAgent(agentId)
            // Only log the final complete response
            console.log('[Agent Response Complete]', message.content)
          } else {
            setAgentActive(agentId, 'Responding...')
          }
          break
        }

        case 'TOOL_PROGRESS': {
          const agentId = (message as { agentId?: string }).agentId || 'default'
          const toolName = (message as { toolName?: string }).toolName || 'tool'
          const status = (message as { status?: string }).status
          if (status === 'running') {
            setAgentActive(agentId, `Running: ${toolName}`)
            console.log('[Tool Start]', toolName)
          } else if (status === 'complete' || status === 'error') {
            // Tool done, but agent may still be working - show thinking
            setAgentActive(agentId, 'Thinking...')
          }
          break
        }

        case 'ERROR':
          console.error('[Agent Error]', message.error)
          setConnectionStatus('error', message.error)
          break

        case 'WINDOW_AGENT_STATUS': {
          const { windowId, agentId, status } = message as {
            windowId: string
            agentId: string
            status: 'created' | 'active' | 'idle' | 'destroyed'
          }
          if (status === 'created') {
            registerWindowAgent(windowId, agentId, status)
          } else if (status === 'destroyed') {
            updateWindowAgentStatus(windowId, status)
          } else {
            updateWindowAgentStatus(windowId, status)
          }
          break
        }

        case 'MESSAGE_ACCEPTED': {
          const { messageId, agentId } = message as { messageId: string; agentId: string }
          console.log('[Message Accepted]', messageId, 'by agent', agentId)
          break
        }

        case 'MESSAGE_QUEUED': {
          const { messageId, position } = message as { messageId: string; position: number }
          console.log('[Message Queued]', messageId, 'at position', position)
          break
        }
      }
    } catch (e) {
      console.error('Failed to parse message:', e)
    }
  }, [applyActions, setConnectionStatus, setSession, addDebugEntry, setAgentActive, clearAgent, registerWindowAgent, updateWindowAgentStatus, checkForPreviousSession])

  // Connect to WebSocket
  const connect = useCallback(() => {
    // Skip if already open or connecting
    if (wsManager.ws?.readyState === WebSocket.OPEN ||
        wsManager.ws?.readyState === WebSocket.CONNECTING) {
      return
    }

    setIsConnecting(true)
    setConnectionStatus('connecting')

    wsManager.ws = new WebSocket(WS_URL)

    wsManager.ws.onopen = () => {
      console.log('WebSocket connected, waiting for agent...')
      // Keep status as 'connecting' until server sends CONNECTION_STATUS
      // This ensures user doesn't send messages before agent is ready
      wsManager.reconnectAttempts = 0
      wsManager.notify()
    }

    wsManager.ws.onmessage = handleMessage

    wsManager.ws.onclose = (event) => {
      console.log('WebSocket closed:', event.code, event.reason)
      setIsConnecting(false)
      setConnectionStatus('disconnected')
      wsManager.ws = null
      wsManager.notify()

      // Auto-reconnect if not a clean close
      if (event.code !== 1000 && wsManager.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        wsManager.reconnectAttempts++
        console.log(`Reconnecting in ${RECONNECT_DELAY}ms (attempt ${wsManager.reconnectAttempts})`)
        wsManager.reconnectTimeout = window.setTimeout(connect, RECONNECT_DELAY)
      }
    }

    wsManager.ws.onerror = (error) => {
      console.error('WebSocket error:', error)
      setConnectionStatus('error', 'Connection failed')
    }
  }, [handleMessage, setConnectionStatus])

  // Disconnect
  const disconnect = useCallback(() => {
    if (wsManager.reconnectTimeout) {
      clearTimeout(wsManager.reconnectTimeout)
      wsManager.reconnectTimeout = null
    }
    wsManager.reconnectAttempts = MAX_RECONNECT_ATTEMPTS // Prevent auto-reconnect

    // Only close if already connected (not while connecting - avoids StrictMode issues)
    if (wsManager.ws?.readyState === WebSocket.OPEN) {
      wsManager.ws.close(1000, 'User disconnect')
      wsManager.ws = null
      wsManager.notify()
    }

    setConnectionStatus('disconnected')
    clearAllAgents()
  }, [setConnectionStatus, clearAllAgents])

  // Send message
  const send = useCallback((event: ClientEvent) => {
    if (wsManager.ws?.readyState === WebSocket.OPEN) {
      // Log outgoing messages to debug panel
      addDebugEntry({
        direction: 'out',
        type: event.type,
        data: event,
      })
      wsManager.ws.send(JSON.stringify(event))
    } else {
      console.warn('WebSocket not connected, cannot send:', event)
    }
  }, [addDebugEntry])

  // Generate a unique message ID
  const generateMessageId = useCallback(() => {
    return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  }, [])

  // Send user message
  const sendMessage = useCallback((content: string) => {
    // Don't show thinking indicator here - let server events drive the UI
    // This prevents duplicate indicators when server sends AGENT_THINKING
    const interactions = consumeInteractions()
    const drawing = consumeDrawing()

    // Add drawing interaction if present (create new array to avoid mutating frozen state)
    const allInteractions = drawing
      ? [...interactions, { type: 'draw' as const, timestamp: Date.now(), imageData: drawing }]
      : interactions

    const messageId = generateMessageId()
    send({ type: 'USER_MESSAGE', messageId, content, interactions: allInteractions.length > 0 ? allInteractions : undefined })
  }, [send, consumeInteractions, consumeDrawing, generateMessageId])

  // Send message to a specific window agent
  const sendWindowMessage = useCallback((windowId: string, content: string) => {
    // Don't show thinking indicator here - let server events drive the UI
    const messageId = generateMessageId()
    send({ type: 'WINDOW_MESSAGE', messageId, windowId, content })
  }, [send, generateMessageId])

  // Send dialog feedback
  const sendDialogFeedback = useCallback((
    dialogId: string,
    confirmed: boolean,
    rememberChoice?: 'once' | 'always' | 'deny_always'
  ) => {
    send({ type: 'DIALOG_FEEDBACK', dialogId, confirmed, rememberChoice })
  }, [send])

  // Send component action (button click) to agent
  const sendComponentAction = useCallback((
    windowId: string,
    windowTitle: string,
    action: string,
    parallel?: boolean,
    formData?: Record<string, string | number | boolean>,
    formId?: string,
    componentPath?: string[]
  ) => {
    // Generate unique actionId for parallel actions to enable concurrent execution
    const actionId = parallel ? `action-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` : undefined
    send({ type: 'COMPONENT_ACTION', windowId, windowTitle, action, actionId, formData, formId, componentPath })
  }, [send])

  // Interrupt current operation
  const interrupt = useCallback(() => {
    send({ type: 'INTERRUPT' })
  }, [send])

  // Set provider
  const setProvider = useCallback((provider: 'claude' | 'codex') => {
    send({ type: 'SET_PROVIDER', provider })
  }, [send])

  // Interrupt a specific agent
  const interruptAgent = useCallback((agentId: string) => {
    send({ type: 'INTERRUPT_AGENT', agentId })
  }, [send])

  // Auto-connect on mount (only when autoConnect is true)
  // With the singleton pattern, only the first hook instance that calls connect() will create the connection
  useEffect(() => {
    if (autoConnect) {
      connect()
    }
    // We don't disconnect on unmount since the connection is shared
    // The connection stays alive as long as the app is running
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Subscribe to pending feedback and send to server
  useEffect(() => {
    const unsubscribe = useDesktopStore.subscribe((state) => {
      if (state.pendingFeedback.length > 0 && wsManager.ws?.readyState === WebSocket.OPEN) {
        const feedback = consumePendingFeedback()
        for (const item of feedback) {
          send({
            type: 'RENDERING_FEEDBACK',
            requestId: item.requestId,
            windowId: item.windowId,
            renderer: item.renderer,
            success: item.success,
            error: item.error,
            url: item.url,
            locked: item.locked,
          })
        }
      }
    })
    return unsubscribe
  }, [consumePendingFeedback, send])

  // Subscribe to window unlock events and execute queued actions
  useEffect(() => {
    let previousWindows = useDesktopStore.getState().windows
    const consumeQueuedActions = useDesktopStore.getState().consumeQueuedActions

    const unsubscribe = useDesktopStore.subscribe((state) => {
      // Check for windows that just transitioned from locked to unlocked
      for (const [windowId, window] of Object.entries(state.windows)) {
        const previousWindow = previousWindows[windowId]
        // Window was locked and is now unlocked
        if (previousWindow?.locked && !window.locked) {
          const queuedActions = consumeQueuedActions(windowId)
          // Execute queued actions sequentially
          for (const action of queuedActions) {
            sendComponentAction(
              action.windowId,
              action.windowTitle,
              action.action,
              action.parallel,
              action.formData,
              action.formId,
              action.componentPath
            )
          }
        }
      }
      previousWindows = state.windows
    })

    return unsubscribe
  }, [sendComponentAction])

  return {
    isConnected,
    isConnecting,
    connect,
    disconnect,
    sendMessage,
    sendWindowMessage,
    sendComponentAction,
    sendDialogFeedback,
    interrupt,
    interruptAgent,
    setProvider,
  }
}
