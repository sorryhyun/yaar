import { generateId } from '@/store/helpers';

export function generateMessageId(): string {
  return generateId('msg');
}

export function generateActionId(parallel?: boolean): string | undefined {
  if (!parallel) return undefined;
  return generateId('action');
}
