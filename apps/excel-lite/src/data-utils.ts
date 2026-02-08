export function cloneMap<T>(map: Record<string, T>): Record<string, T> {
  return JSON.parse(JSON.stringify(map));
}

export function csvEscape(value: string): string {
  if (/[\",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
