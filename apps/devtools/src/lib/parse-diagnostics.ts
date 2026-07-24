export {};
import type { Diagnostic } from '../core/types';

// Pure: compiler output text -> structured diagnostics. No signals, no I/O.

export function parseDiagnostics(raw: string): Diagnostic[] {
  const lines = raw.split('\n');
  const result: Diagnostic[] = [];
  for (const line of lines) {
    // Match: src/main.ts(12,5): error TS2304: Cannot find name 'x'.
    const m = line.match(/^(.+?)\((\d+),\d+\):\s*(error|warning)\s+\w+:\s*(.+)/);
    if (m) {
      result.push({
        file: m[1],
        line: parseInt(m[2], 10),
        message: m[4],
        severity: m[3] as 'error' | 'warning',
      });
    }
  }
  return result;
}
