export {};
import type { Diagnostic } from '../core/types';

// Pure: compiler output text -> structured diagnostics. No signals, no I/O.

export function parseDiagnostics(raw: string): Diagnostic[] {
  const lines = raw.split('\n');
  const result: Diagnostic[] = [];
  for (const line of lines) {
    // Match: src/main.ts(12,5): error TS2304: Cannot find name 'x'.
    const m = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(\w+):\s*(.+)/);
    if (m) {
      result.push({
        file: m[1],
        line: parseInt(m[2], 10),
        column: parseInt(m[3], 10),
        // The code is what to search for: TS2532 names the failure across every phrasing.
        code: m[5],
        message: m[6],
        severity: m[4] as 'error' | 'warning',
      });
    }
  }
  return result;
}
