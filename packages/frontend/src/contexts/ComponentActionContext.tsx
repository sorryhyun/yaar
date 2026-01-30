/**
 * ComponentActionContext - Provides component action handling to the window tree.
 */
import { createContext, useContext } from 'react'

export type FormValue = string | number | boolean

type SendComponentAction = (
  windowId: string,
  action: string,
  parallel?: boolean,
  formData?: Record<string, FormValue>,
  formId?: string
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

export function useComponentAction(): SendComponentAction | null {
  return useContext(ComponentActionContext)
}
