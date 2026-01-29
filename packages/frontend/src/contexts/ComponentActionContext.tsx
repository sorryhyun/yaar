/**
 * ComponentActionContext - Provides component action handling to the window tree.
 */
import { createContext, useContext } from 'react'

type SendComponentAction = (windowId: string, action: string) => void

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

export function useComponentAction(): SendComponentAction | null {
  return useContext(ComponentActionContext)
}
