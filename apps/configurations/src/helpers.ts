/**
 * Parse text the *user is currently typing* into the extra-settings textarea.
 *
 * Deliberately exempt from the "log, don't swallow" rule that covers the config
 * reads in `api.ts`: this runs on every keystroke, so half-typed JSON is the
 * normal case rather than a fault, and logging it would bury real failures. The
 * one caller that acts on the result (`settings-view`'s `save`) already refuses
 * to save and toasts "Invalid JSON in extra settings", which is where the user
 * should hear about it.
 */
export function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function extractText(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result ?? '');
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Returns an InputEvent handler that pipes the element value into a setter */
export const onInputHandler = (setter: (v: string) => void) => (e: InputEvent) =>
  setter((e.target as HTMLInputElement).value);

/** Returns a change event handler for <select> elements */
export const onChangeHandler = (setter: (v: string) => void) => (e: Event) =>
  setter((e.target as HTMLSelectElement).value);
