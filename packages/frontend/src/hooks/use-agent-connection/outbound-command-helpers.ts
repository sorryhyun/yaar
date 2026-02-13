export function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function generateActionId(parallel?: boolean): string | undefined {
  if (!parallel) return undefined;
  return `action-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
