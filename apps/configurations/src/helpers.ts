export function parseJson<T>(text: string, fallback: T): T {
  try { return JSON.parse(text); } catch { return fallback; }
}

export function extractText(result: { content: Array<{ text?: string }> }): string {
  return result?.content?.[0]?.text ?? '';
}
