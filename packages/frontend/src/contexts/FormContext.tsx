/**
 * FormContext - Manages form state for component DSL forms.
 *
 * Forms collect data locally without sending to the AI until a button
 * with submitForm is clicked.
 */
import { createContext, useContext, useCallback, useRef } from 'react'

export type FormValue = string | number | boolean

export interface FormContextType {
  /**
   * Register a form with the context.
   */
  registerForm: (formId: string) => void

  /**
   * Unregister a form when it unmounts.
   */
  unregisterForm: (formId: string) => void

  /**
   * Set a field value in a form.
   */
  setFieldValue: (formId: string, fieldName: string, value: FormValue) => void

  /**
   * Get all field values for a form.
   */
  getFormData: (formId: string) => Record<string, FormValue> | undefined
}

const FormContext = createContext<FormContextType | null>(null)

export function FormProvider({ children }: { children: React.ReactNode }) {
  // Use ref to avoid re-renders when form data changes
  const formsRef = useRef<Map<string, Record<string, FormValue>>>(new Map())

  const registerForm = useCallback((formId: string) => {
    if (!formsRef.current.has(formId)) {
      formsRef.current.set(formId, {})
    }
  }, [])

  const unregisterForm = useCallback((formId: string) => {
    formsRef.current.delete(formId)
  }, [])

  const setFieldValue = useCallback((formId: string, fieldName: string, value: FormValue) => {
    const formData = formsRef.current.get(formId)
    if (formData) {
      formData[fieldName] = value
    } else {
      // Auto-register form if not registered
      formsRef.current.set(formId, { [fieldName]: value })
    }
  }, [])

  const getFormData = useCallback((formId: string) => {
    return formsRef.current.get(formId)
  }, [])

  const value: FormContextType = {
    registerForm,
    unregisterForm,
    setFieldValue,
    getFormData,
  }

  return (
    <FormContext.Provider value={value}>
      {children}
    </FormContext.Provider>
  )
}

export function useFormContext(): FormContextType | null {
  return useContext(FormContext)
}

/**
 * Hook for form fields to update their value in the form context.
 */
export function useFormField(formId: string | undefined, fieldName: string, defaultValue?: FormValue) {
  const formContext = useFormContext()

  const setValue = useCallback((value: FormValue) => {
    if (formId && formContext) {
      formContext.setFieldValue(formId, fieldName, value)
    }
  }, [formId, fieldName, formContext])

  // Initialize with default value if provided
  const initialized = useRef(false)
  if (!initialized.current && formId && formContext && defaultValue !== undefined) {
    formContext.setFieldValue(formId, fieldName, defaultValue)
    initialized.current = true
  }

  return { setValue }
}
