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
 * @param formId - The ID of the form this field belongs to
 * @param fieldName - The name of the field (used as key in form data)
 * @param initialValue - The initial value for the field (defaults to empty string)
 */
export function useFormField(formId: string | undefined, fieldName: string, initialValue: FormValue = '') {
  const formContext = useFormContext()

  const setValue = useCallback((value: FormValue) => {
    if (formId && formContext) {
      formContext.setFieldValue(formId, fieldName, value)
    }
  }, [formId, fieldName, formContext])

  // Always register field with its initial value on mount
  // This ensures all fields appear in form data even if user hasn't typed
  const initialized = useRef(false)
  if (!initialized.current && formId && formContext) {
    formContext.setFieldValue(formId, fieldName, initialValue)
    initialized.current = true
  }

  return { setValue }
}
