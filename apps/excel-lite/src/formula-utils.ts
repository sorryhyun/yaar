import { colLabel, colNumber, expandRange } from './ref-utils';

type GetRawFn = (ref: string) => string;

export function createFormulaEngine(getRaw: GetRawFn) {
  function evalCell(ref: string, seen = new Set<string>()): number {
    if (seen.has(ref)) return NaN;
    seen.add(ref);

    const raw = getRaw(ref).trim();
    if (!raw) return 0;

    if (!raw.startsWith('=')) {
      const n = Number(raw);
      return Number.isFinite(n) ? n : NaN;
    }

    return evalFormula(raw.slice(1), seen);
  }

  function evalFormula(expr: string, seen: Set<string>): number {
    try {
      let safe = expr.toUpperCase();

      safe = safe.replace(/SUM\(\s*([A-Z]+\d+)\s*:\s*([A-Z]+\d+)\s*\)/g, (_, a, b) => {
        return String(
          expandRange(a, b).reduce((acc, ref) => {
            const v = evalCell(ref, new Set(seen));
            return acc + (Number.isFinite(v) ? v : 0);
          }, 0)
        );
      });

      safe = safe.replace(/\b([A-Z]+\d+)\b/g, (_, ref) => {
        const v = evalCell(ref, new Set(seen));
        return Number.isFinite(v) ? String(v) : 'NaN';
      });

      if (!/^[0-9+\-*/().\sNAN]+$/.test(safe)) return NaN;
      const result = Function(`"use strict"; return (${safe});`)();
      return Number.isFinite(result) ? result : NaN;
    } catch {
      return NaN;
    }
  }

  function display(ref: string): string {
    const raw = getRaw(ref);
    if (!raw.startsWith('=')) return raw;
    const v = evalCell(ref);
    return Number.isFinite(v) ? String(v) : '#ERR';
  }

  return { evalCell, display };
}

export function shiftFormula(raw: string, rowShift: number, colShift: number): string {
  if (!raw.startsWith('=')) return raw;
  return raw.replace(/\b([A-Z]+)(\d+)\b/g, (_, letters: string, rowNum: string) => {
    const c = Math.max(1, colNumber(letters) + colShift);
    const r = Math.max(1, Number(rowNum) + rowShift);
    return `${colLabel(c)}${r}`;
  });
}
