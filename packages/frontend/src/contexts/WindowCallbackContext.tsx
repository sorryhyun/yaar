/**
 * WindowCallbackContext - Per-window stable callbacks for rendering feedback
 * and component actions. Provided by WindowFrame, consumed by renderers.
 *
 * Keeps onRenderSuccess / onRenderError / onComponentAction out of ContentRenderer
 * and ComponentRenderer props so adding new renderers doesn't require threading them.
 */
import { createContext, useContext } from 'react';
import type { FormValue } from './FormContext';

export interface WindowCallbacks {
  onRenderSuccess: (requestId: string, windowId: string, renderer: string) => void;
  onRenderError: (
    requestId: string,
    windowId: string,
    renderer: string,
    error: string,
    url?: string,
  ) => void;
  onComponentAction: (
    action: string,
    parallel?: boolean,
    formData?: Record<string, FormValue>,
    formId?: string,
    componentPath?: string[],
  ) => void;
}

const WindowCallbackContext = createContext<WindowCallbacks | null>(null);

export function WindowCallbackProvider({
  children,
  callbacks,
}: {
  children: React.ReactNode;
  callbacks: WindowCallbacks;
}) {
  return (
    <WindowCallbackContext.Provider value={callbacks}>{children}</WindowCallbackContext.Provider>
  );
}

export function useWindowCallbacks(): WindowCallbacks | null {
  return useContext(WindowCallbackContext);
}
