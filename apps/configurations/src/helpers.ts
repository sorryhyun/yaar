export function parseJson<T>(text: string, fallback: T): T {
  try { return JSON.parse(text); } catch { return fallback; }
}

export function extractText(result: { content: Array<{ text?: string }> }): string {
  return result?.content?.[0]?.text ?? '';
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Returns an InputEvent handler that pipes the element value into a setter */
export const onInputHandler =
  (setter: (v: string) => void) =>
  (e: InputEvent) =>
    setter((e.target as HTMLInputElement).value);

/** Returns a change event handler for <select> elements */
export const onChangeHandler =
  (setter: (v: string) => void) =>
  (e: Event) =>
    setter((e.target as HTMLSelectElement).value);
