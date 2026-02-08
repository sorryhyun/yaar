import type { ServerEvent, OSAction } from '@/types'

export interface ServerEventDispatchHandlers {
  applyActions: (actions: OSAction[]) => void
  setIsConnecting: (value: boolean) => void
  setConnectionStatus: (status: 'connecting' | 'connected' | 'disconnected' | 'error', error?: string) => void
  setSession: (provider: string, sessionId: string) => void
  checkForPreviousSession: (sessionId: string) => void
  addDebugEntry: (entry: { direction: 'in'; type: string; data: ServerEvent }) => void
  setAgentActive: (agentId: string, status: string) => void
  clearAgent: (agentId: string) => void
  registerWindowAgent: (windowId: string, agentId: string, status: 'assigned' | 'active' | 'released') => void
  updateWindowAgentStatus: (agentId: string, status: 'assigned' | 'active' | 'released') => void
}

export function dispatchServerEvent(message: ServerEvent, handlers: ServerEventDispatchHandlers) {
  const shouldLog =
    message.type === 'ACTIONS' ||
    message.type === 'CONNECTION_STATUS' ||
    message.type === 'ERROR' ||
    (message.type === 'AGENT_RESPONSE' && (message as { isComplete?: boolean }).isComplete) ||
    (message.type === 'TOOL_PROGRESS' && (message as { status?: string }).status !== 'running')

  if (shouldLog) {
    handlers.addDebugEntry({
      direction: 'in',
      type: message.type,
      data: message,
    })
  }

  switch (message.type) {
    case 'ACTIONS':
      handlers.applyActions(message.actions)
      break
    case 'CONNECTION_STATUS':
      handlers.setIsConnecting(false)
      handlers.setConnectionStatus(
        message.status === 'connected' ? 'connected' :
        message.status === 'error' ? 'error' : 'disconnected',
        message.error,
      )
      if (message.provider && message.sessionId) {
        handlers.setSession(message.provider, message.sessionId)
        handlers.checkForPreviousSession(message.sessionId)
      }
      break
    case 'AGENT_THINKING': {
      const agentId = (message as { agentId?: string }).agentId || 'default'
      handlers.setAgentActive(agentId, 'Thinking...')
      break
    }
    case 'AGENT_RESPONSE': {
      const agentId = (message as { agentId?: string }).agentId || 'default'
      const isComplete = (message as { isComplete?: boolean }).isComplete
      if (isComplete) {
        handlers.clearAgent(agentId)
      } else {
        handlers.setAgentActive(agentId, 'Responding...')
      }
      break
    }
    case 'TOOL_PROGRESS': {
      const agentId = (message as { agentId?: string }).agentId || 'default'
      const toolName = (message as { toolName?: string }).toolName || 'tool'
      const status = (message as { status?: string }).status
      if (status === 'running') {
        handlers.setAgentActive(agentId, `Running: ${toolName}`)
      } else if (status === 'complete' || status === 'error') {
        handlers.setAgentActive(agentId, 'Thinking...')
      }
      break
    }
    case 'ERROR':
      handlers.setConnectionStatus('error', message.error)
      break
    case 'WINDOW_AGENT_STATUS': {
      const { windowId, agentId, status } = message
      if (status === 'assigned') {
        handlers.registerWindowAgent(windowId, agentId, status)
      } else {
        handlers.updateWindowAgentStatus(agentId, status)
      }
      break
    }
    case 'APPROVAL_REQUEST': {
      // Convert to a dialog.confirm action and route through the existing dialog system.
      // This keeps the existing ConfirmDialog UI working; can be upgraded to inline later.
      handlers.applyActions([{
        type: 'dialog.confirm' as const,
        id: message.dialogId,
        title: message.title,
        message: message.message,
        confirmText: message.confirmText,
        cancelText: message.cancelText,
        permissionOptions: message.permissionOptions,
      }])
      break
    }
  }
}
