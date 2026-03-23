import { colLabel, colNumber, expandRange } from './ref-utils';

type GetRawFn = (ref: string) => string;

export function createFormulaEngine(getRaw: GetRawFn) {

  // ── Internal helpers ──────────────────────────────────────────────────

  /** Evaluate an expression and coerce to number (cloned seen set). */
  function evalNum(v: string, seen: Set<string>): number {
    return Number(evalMixed(v.trim(), new Set(seen)));
  }

  /** Wrap a mixed result as a quoted string literal or plain number string. */
  function wrapResult(val: string | number): string {
    return typeof val === 'string' ? `"${val}"` : String(val);
  }

  /** Excel-style truthiness: 0, '', and 'FALSE' are falsy. */
  function isTruthy(v: string | number): boolean {
    return Number(v) !== 0 && v !== '' && v !== 'FALSE';
  }

  /** Compare a raw cell value against an Excel-style criterion string. */
  function matchesCriterion(val: string, criterion: string): boolean {
    if (criterion.startsWith('>=')) return Number(val) >= Number(criterion.slice(2));
    if (criterion.startsWith('<=')) return Number(val) <= Number(criterion.slice(2));
    if (criterion.startsWith('>'))  return Number(val) >  Number(criterion.slice(1));
    if (criterion.startsWith('<'))  return Number(val) <  Number(criterion.slice(1));
    return val.toUpperCase() === criterion.toUpperCase();
  }

  /** Sample variance of an array (returns 0 when fewer than 2 values). */
  function sampleVariance(vals: number[]): number {
    if (vals.length < 2) return 0;
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    return vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length - 1);
  }

  /** Return the k-th largest or smallest value from an array. */
  function nthSortedValue(vals: number[], k: string, desc: boolean): string {
    const sorted = [...vals].sort((a, b) => desc ? b - a : a - b);
    const ki = Math.round(Number(k)) - 1;
    return String(ki >= 0 && ki < sorted.length ? sorted[ki] : NaN);
  }

  /** Apply a rounding function with a decimal factor (shared by ROUND/UP/DOWN). */
  function applyRound(fn: (x: number) => number, v: string, d: string, seen: Set<string>): string {
    const factor = Math.pow(10, Number(d));
    return String(fn(evalNum(v, seen) * factor) / factor);
  }

  /** Iteratively apply a regex replacement until the expression stabilises. */
  function processIteratively(
    expr: string,
    pattern: RegExp,
    replacer: (match: string, inner: string) => string
  ): string {
    let result = expr;
    let prev = '';
    while (result !== prev) {
      prev = result;
      result = result.replace(pattern, replacer);
    }
    return result;
  }

  // ── Range helpers ─────────────────────────────────────────────────────

  function getNumericValues(a: string, b: string, seen: Set<string>): number[] {
    return expandRange(a, b)
      .map(ref => evalCell(ref, new Set(seen)))
      .filter(v => Number.isFinite(v));
  }

  function evalCell(ref: string, seen = new Set<string>()): number {
    if (seen.has(ref)) return NaN;
    seen.add(ref);
    const raw = getRaw(ref).trim();
    if (!raw) return 0;
    if (!raw.startsWith('=')) {
      const n = Number(raw);
      return Number.isFinite(n) ? n : NaN;
    }
    const result = evalMixed(raw.slice(1), seen);
    if (typeof result === 'number') return result;
    const n = Number(result);
    return Number.isFinite(n) ? n : NaN;
  }

  function evalString(ref: string, seen = new Set<string>()): string {
    const raw = getRaw(ref).trim();
    if (!raw.startsWith('=')) return raw;
    const result = evalMixed(raw.slice(1), seen);
    return String(result ?? '');
  }

  // ── Main evaluator ────────────────────────────────────────────────────

  function evalMixed(expr: string, seen: Set<string>): string | number {
    try {
      let safe = expr.toUpperCase();

      // === LOGICAL ===
      safe = processIF(safe, seen);
      safe = processIFERROR(safe, seen);

      safe = safe.replace(/\bAND\(([^)]+)\)/g, (_, args: string) => {
        const vals = splitArgs(args).map((a: string) => evalMixed(a.trim(), new Set(seen)));
        return String(vals.every(isTruthy) ? 1 : 0);
      });
      safe = safe.replace(/\bOR\(([^)]+)\)/g, (_, args: string) => {
        const vals = splitArgs(args).map((a: string) => evalMixed(a.trim(), new Set(seen)));
        return String(vals.some(isTruthy) ? 1 : 0);
      });
      safe = safe.replace(/\bNOT\(([^)]+)\)/g, (_, a: string) => {
        return String(isTruthy(evalMixed(a.trim(), new Set(seen))) ? 0 : 1);
      });

      // === RANGE FUNCTIONS ===
      safe = safe.replace(/\bSUM\(([A-Z]+\d+):([A-Z]+\d+)\)/g, (_, a: string, b: string) =>
        String(expandRange(a, b).reduce((acc, ref) => {
          const v = evalCell(ref, new Set(seen));
          return acc + (Number.isFinite(v) ? v : 0);
        }, 0)));

      safe = safe.replace(/\bAVERAGE\(([A-Z]+\d+):([A-Z]+\d+)\)/g, (_, a: string, b: string) => {
        const vals = getNumericValues(a, b, seen);
        return String(vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0);
      });

      safe = safe.replace(/\bCOUNT\(([A-Z]+\d+):([A-Z]+\d+)\)/g, (_, a: string, b: string) =>
        String(expandRange(a, b).filter(ref => Number.isFinite(evalCell(ref, new Set(seen)))).length));

      safe = safe.replace(/\bCOUNTA\(([A-Z]+\d+):([A-Z]+\d+)\)/g, (_, a: string, b: string) =>
        String(expandRange(a, b).filter(ref => getRaw(ref).trim() !== '').length));

      safe = safe.replace(/\bMIN\(([A-Z]+\d+):([A-Z]+\d+)\)/g, (_, a: string, b: string) => {
        const vals = getNumericValues(a, b, seen);
        return String(vals.length ? Math.min(...vals) : 0);
      });

      safe = safe.replace(/\bMAX\(([A-Z]+\d+):([A-Z]+\d+)\)/g, (_, a: string, b: string) => {
        const vals = getNumericValues(a, b, seen);
        return String(vals.length ? Math.max(...vals) : 0);
      });

      safe = safe.replace(/\bSTDEV\(([A-Z]+\d+):([A-Z]+\d+)\)/g, (_, a: string, b: string) =>
        String(Math.sqrt(sampleVariance(getNumericValues(a, b, seen)))));

      safe = safe.replace(/\bVAR\(([A-Z]+\d+):([A-Z]+\d+)\)/g, (_, a: string, b: string) =>
        String(sampleVariance(getNumericValues(a, b, seen))));

      safe = safe.replace(/\bLARGE\(([A-Z]+\d+):([A-Z]+\d+),([^)]+)\)/g, (_, a: string, b: string, k: string) =>
        nthSortedValue(getNumericValues(a, b, seen), k, true));

      safe = safe.replace(/\bSMALL\(([A-Z]+\d+):([A-Z]+\d+),([^)]+)\)/g, (_, a: string, b: string, k: string) =>
        nthSortedValue(getNumericValues(a, b, seen), k, false));

      // COUNTIF(range, criterion)
      safe = safe.replace(/\bCOUNTIF\(([A-Z]+\d+):([A-Z]+\d+),"?([^",)]*)"?\)/g, (_, a: string, b: string, crit: string) => {
        const criterion = crit.trim();
        return String(expandRange(a, b).filter(ref => matchesCriterion(getRaw(ref).trim(), criterion)).length);
      });

      // SUMIF(range, criterion, sum_range?)
      safe = safe.replace(/\bSUMIF\(([A-Z]+\d+):([A-Z]+\d+),"?([^",)]*)"?(?:,([A-Z]+\d+):([A-Z]+\d+))?\)/g,
        (_, a: string, b: string, crit: string, sa: string, sb: string) => {
          const criterion = crit.trim();
          const testRefs = expandRange(a, b);
          const sumRefs = sa && sb ? expandRange(sa, sb) : testRefs;
          let total = 0;
          testRefs.forEach((ref, i) => {
            if (matchesCriterion(getRaw(ref).trim(), criterion) && sumRefs[i]) {
              const v = evalCell(sumRefs[i], new Set(seen));
              total += Number.isFinite(v) ? v : 0;
            }
          });
          return String(total);
        });

      // === MATH FUNCTIONS ===
      safe = safe.replace(/\bROUND\(([^,)]+),([^)]+)\)/g,     (_, v, d) => applyRound(Math.round, v, d, seen));
      safe = safe.replace(/\bROUNDUP\(([^,)]+),([^)]+)\)/g,   (_, v, d) => applyRound(Math.ceil,  v, d, seen));
      safe = safe.replace(/\bROUNDDOWN\(([^,)]+),([^)]+)\)/g, (_, v, d) => applyRound(Math.floor, v, d, seen));

      safe = safe.replace(/\bABS\(([^)]+)\)/g,     (_, v: string) => String(Math.abs(evalNum(v, seen))));
      safe = safe.replace(/\bSQRT\(([^)]+)\)/g,    (_, v: string) => String(Math.sqrt(evalNum(v, seen))));
      safe = safe.replace(/\bFLOOR\(([^)]+)\)/g,   (_, v: string) => String(Math.floor(evalNum(v, seen))));
      safe = safe.replace(/\bCEILING\(([^)]+)\)/g, (_, v: string) => String(Math.ceil(evalNum(v, seen))));
      safe = safe.replace(/\bINT\(([^)]+)\)/g,     (_, v: string) => String(Math.trunc(evalNum(v, seen))));
      safe = safe.replace(/\bLN\(([^)]+)\)/g,      (_, v: string) => String(Math.log(evalNum(v, seen))));
      safe = safe.replace(/\bEXP\(([^)]+)\)/g,     (_, v: string) => String(Math.exp(evalNum(v, seen))));

      safe = safe.replace(/\bPOWER\(([^,)]+),([^)]+)\)/g, (_, v: string, e: string) =>
        String(Math.pow(evalNum(v, seen), evalNum(e, seen))));

      safe = safe.replace(/\bMOD\(([^,)]+),([^)]+)\)/g, (_, v: string, d: string) =>
        String(evalNum(v, seen) % evalNum(d, seen)));

      // LOG after LN to avoid partial match
      safe = safe.replace(/\bLOG\(([^,)]+)(?:,([^)]+))?\)/g, (_, v: string, base: string) => {
        const val = evalNum(v, seen);
        const b = base ? evalNum(base, seen) : 10;
        return String(Math.log(val) / Math.log(b));
      });

      safe = safe.replace(/\bPI\(\)/g, String(Math.PI));
      safe = safe.replace(/\bRAND\(\)/g, String(Math.random()));

      // === TEXT FUNCTIONS ===
      safe = safe.replace(/\bLEN\(([A-Z]+\d+)\)/g, (_, ref: string) =>
        String(evalString(ref, new Set(seen)).length));

      safe = safe.replace(/\bUPPER\(([A-Z]+\d+)\)/g, (_, ref: string) =>
        `"${evalString(ref, new Set(seen)).toUpperCase()}"`);

      safe = safe.replace(/\bLOWER\(([A-Z]+\d+)\)/g, (_, ref: string) =>
        `"${evalString(ref, new Set(seen)).toLowerCase()}"`);

      safe = safe.replace(/\bTRIM\(([A-Z]+\d+)\)/g, (_, ref: string) =>
        `"${evalString(ref, new Set(seen)).trim()}"`);

      safe = safe.replace(/\bLEFT\(([A-Z]+\d+),([^)]+)\)/g, (_, ref: string, n: string) =>
        `"${evalString(ref, new Set(seen)).slice(0, Number(n))}"`);

      safe = safe.replace(/\bRIGHT\(([A-Z]+\d+),([^)]+)\)/g, (_, ref: string, n: string) => {
        const s = evalString(ref, new Set(seen));
        return `"${s.slice(Math.max(0, s.length - Number(n)))}"`;
      });

      safe = safe.replace(/\bMID\(([A-Z]+\d+),([^,)]+),([^)]+)\)/g, (_, ref: string, start: string, len: string) =>
        `"${evalString(ref, new Set(seen)).slice(Number(start) - 1, Number(start) - 1 + Number(len))}"`);

      // CONCAT / CONCATENATE
      safe = safe.replace(/\bCONCAT(?:ENATE)?\(([^)]+)\)/g, (_, args: string) => {
        const parts = splitArgs(args).map((a: string) => {
          const t = a.trim();
          if (/^[A-Z]+\d+$/.test(t)) return evalString(t, new Set(seen));
          if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
          return String(evalMixed(t, new Set(seen)));
        });
        return `"${parts.join('')}"`;
      });

      // === DATE FUNCTIONS ===
      safe = safe.replace(/\bNOW\(\)/g,  () => `"${new Date().toLocaleString()}"`);
      safe = safe.replace(/\bTODAY\(\)/g, () => `"${new Date().toLocaleDateString()}"`);
      safe = safe.replace(/\bYEAR\(([A-Z]+\d+)\)/g,  (_, ref: string) => String(new Date(getRaw(ref)).getFullYear()));
      safe = safe.replace(/\bMONTH\(([A-Z]+\d+)\)/g, (_, ref: string) => String(new Date(getRaw(ref)).getMonth() + 1));
      safe = safe.replace(/\bDAY\(([A-Z]+\d+)\)/g,   (_, ref: string) => String(new Date(getRaw(ref)).getDate()));

      // === CELL REFS → numeric ===
      safe = safe.replace(/\b([A-Z]+\d+)\b/g, (_, ref: string) => {
        const v = evalCell(ref, new Set(seen));
        return Number.isFinite(v) ? String(v) : 'NaN';
      });

      // Extract quoted string result
      const strMatch = safe.match(/^"(.*)"$/s);
      if (strMatch) return strMatch[1];

      // Numeric eval
      const numericOnly = safe.replace(/"[^"]*"/g, '""');
      if (!/^[0-9+\-*/().\s,NAN INFINITY<>=!&|"]+$/i.test(numericOnly)) return NaN;
      // eslint-disable-next-line no-new-func
      const result = Function(`"use strict"; return (${safe});`)();
      if (typeof result === 'string') return result;
      return Number.isFinite(result) ? result : NaN;
    } catch {
      return NaN;
    }
  }

  // ── IF / IFERROR processors ────────────────────────────────────────────

  function processIF(expr: string, seen: Set<string>): string {
    return processIteratively(expr, /\bIF\(([^()]*)\)/g, (_, inner: string) => {
      const args = splitArgs(inner);
      if (args.length < 2) return 'NaN';
      const cond     = args[0].trim();
      const trueVal  = (args[1] ?? '0').trim();
      const falseVal = (args[2] ?? '0').trim();

      let condResult: boolean;
      try {
        const condSafe = cond.replace(/\b([A-Z]+\d+)\b/g, (__, ref: string) => {
          const v = evalCell(ref, new Set(seen));
          return Number.isFinite(v) ? String(v) : '0';
        });
        // eslint-disable-next-line no-new-func
        condResult = Boolean(Function(`"use strict"; return (${condSafe});`)());
      } catch {
        condResult = false;
      }

      return wrapResult(evalMixed(condResult ? trueVal : falseVal, new Set(seen)));
    });
  }

  function processIFERROR(expr: string, seen: Set<string>): string {
    return processIteratively(expr, /\bIFERROR\(([^()]*)\)/g, (_, inner: string) => {
      const args = splitArgs(inner);
      if (args.length < 2) return 'NaN';
      try {
        const val = evalMixed(args[0].trim(), new Set(seen));
        if (typeof val === 'number' && isNaN(val)) {
          return wrapResult(evalMixed(args[1].trim(), new Set(seen)));
        }
        return wrapResult(val);
      } catch {
        return wrapResult(evalMixed(args[1].trim(), new Set(seen)));
      }
    });
  }

  // ── Argument splitter ─────────────────────────────────────────────────

  /** Split comma-separated args, respecting parenthesis depth. */
  function splitArgs(inner: string): string[] {
    const args: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of inner) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        args.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current) args.push(current);
    return args;
  }

  // ── Public API ────────────────────────────────────────────────────────

  function display(ref: string): string {
    const raw = getRaw(ref);
    if (!raw.startsWith('=')) return raw;
    const result = evalMixed(raw.slice(1), new Set());
    if (typeof result === 'string') return result;
    return Number.isFinite(result) ? String(result) : '#ERR';
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
