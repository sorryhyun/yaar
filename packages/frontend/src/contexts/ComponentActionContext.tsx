/**
 * ComponentActionContext - Provides component action handling to the window tree.
 */
import { createContext, useContext, useCallback } from 'react'
import { useDesktopStore } from '@/store'

export type FormValue = string | number | boolean

type SendComponentAction = (
  windowId: string,
  windowTitle: string,
  action: string,
  parallel?: boolean,
  formData?: Record<string, FormValue>,
  formId?: string,
  componentPath?: string[]
) => void

const ComponentActionContext = createContext<SendComponentAction | null>(null)

export function ComponentActionProvider({
  children,
  sendComponentAction,
}: {
  children: React.ReactNode
  sendComponentAction: SendComponentAction
}) {
  return (
    <ComponentActionContext.Provider value={sendComponentAction}>
      {children}
    </ComponentActionContext.Provider>
  )
}

/**
 * Queue-aware wrapper that checks window lock state before sending.
 * If window is locked, queues the action for later execution.
 */
export function QueueAwareComponentActionProvider({
  children,
  sendComponentAction,
}: {
  children: React.ReactNode
  sendComponentAction: SendComponentAction
}) {
  const queueComponentAction = useDesktopStore(s => s.queueComponentAction)

  const queueAwareSend: SendComponentAction = useCallback((
    windowId,
    windowTitle,
    action,
    parallel,
    formData,
    formId,
    componentPath
  ) => {
    // Check lock state at click time via getState() to avoid subscribing to all window mutations
    const window = useDesktopStore.getState().windows[windowId]

    // If window is locked, queue the action
    if (window?.locked) {
      queueComponentAction({
        windowId,
        windowTitle,
        action,
        parallel,
        formData,
        formId,
        componentPath,
        queuedAt: Date.now(),
      })
      return
    }

    // Otherwise send immediately
    sendComponentAction(windowId, windowTitle, action, parallel, formData, formId, componentPath)
  }, [queueComponentAction, sendComponentAction])

  return (
    <ComponentActionContext.Provider value={queueAwareSend}>
      {children}
    </ComponentActionContext.Provider>
  )
}

export function useComponentAction(): SendComponentAction | null {
  return useContext(ComponentActionContext)
}
