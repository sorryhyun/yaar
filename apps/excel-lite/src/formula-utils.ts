import { colLabel, colNumber, expandRange } from './ref-utils';

type GetRawFn = (ref: string) => string;

export function createFormulaEngine(getRaw: GetRawFn) {

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

  // Main evaluator - returns string | number
  function evalMixed(expr: string, seen: Set<string>): string | number {
    try {
      let safe = expr.toUpperCase();

      // === LOGICAL (must process before other replacements) ===
      safe = processIF(safe, seen);
      safe = processIFERROR(safe, seen);

      // AND(a,b,...), OR(a,b,...), NOT(a)
      safe = safe.replace(/\bAND\(([^)]+)\)/g, (_, args: string) => {
        const vals = splitArgs(args).map((a: string) => evalMixed(a.trim(), new Set(seen)));
        return String(vals.every(v => Number(v) !== 0 && v !== '' && v !== 'FALSE') ? 1 : 0);
      });
      safe = safe.replace(/\bOR\(([^)]+)\)/g, (_, args: string) => {
        const vals = splitArgs(args).map((a: string) => evalMixed(a.trim(), new Set(seen)));
        return String(vals.some(v => Number(v) !== 0 && v !== '' && v !== 'FALSE') ? 1 : 0);
      });
      safe = safe.replace(/\bNOT\(([^)]+)\)/g, (_, a: string) => {
        const v = evalMixed(a.trim(), new Set(seen));
        return String(Number(v) === 0 || v === '' || v === 'FALSE' ? 1 : 0);
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

      // STDEV(range)
      safe = safe.replace(/\bSTDEV\(([A-Z]+\d+):([A-Z]+\d+)\)/g, (_, a: string, b: string) => {
        const vals = getNumericValues(a, b, seen);
        if (vals.length < 2) return '0';
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        const variance = vals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (vals.length - 1);
        return String(Math.sqrt(variance));
      });

      // VAR(range)
      safe = safe.replace(/\bVAR\(([A-Z]+\d+):([A-Z]+\d+)\)/g, (_, a: string, b: string) => {
        const vals = getNumericValues(a, b, seen);
        if (vals.length < 2) return '0';
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        return String(vals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (vals.length - 1));
      });

      // LARGE(range, k)
      safe = safe.replace(/\bLARGE\(([A-Z]+\d+):([A-Z]+\d+),([^)]+)\)/g, (_, a: string, b: string, k: string) => {
        const vals = getNumericValues(a, b, seen).sort((x, y) => y - x);
        const ki = Math.round(Number(k)) - 1;
        return String(ki >= 0 && ki < vals.length ? vals[ki] : NaN);
      });

      // SMALL(range, k)
      safe = safe.replace(/\bSMALL\(([A-Z]+\d+):([A-Z]+\d+),([^)]+)\)/g, (_, a: string, b: string, k: string) => {
        const vals = getNumericValues(a, b, seen).sort((x, y) => x - y);
        const ki = Math.round(Number(k)) - 1;
        return String(ki >= 0 && ki < vals.length ? vals[ki] : NaN);
      });

      // COUNTIF(range, criterion)
      safe = safe.replace(/\bCOUNTIF\(([A-Z]+\d+):([A-Z]+\d+),"?([^",)]*)"?\)/g, (_, a: string, b: string, crit: string) => {
        const criterion = crit.trim();
        const count = expandRange(a, b).filter(ref => {
          const val = getRaw(ref).trim();
          if (criterion.startsWith('>=')) return Number(val) >= Number(criterion.slice(2));
          if (criterion.startsWith('<=')) return Number(val) <= Number(criterion.slice(2));
          if (criterion.startsWith('>')) return Number(val) > Number(criterion.slice(1));
          if (criterion.startsWith('<')) return Number(val) < Number(criterion.slice(1));
          return val.toUpperCase() === criterion.toUpperCase();
        }).length;
        return String(count);
      });

      // SUMIF(range, criterion, sum_range?) or SUMIF(range, criterion)
      safe = safe.replace(/\bSUMIF\(([A-Z]+\d+):([A-Z]+\d+),"?([^",)]*)"?(?:,([A-Z]+\d+):([A-Z]+\d+))?\)/g,
        (_, a: string, b: string, crit: string, sa: string, sb: string) => {
          const criterion = crit.trim();
          const testRefs = expandRange(a, b);
          const sumRefs = sa && sb ? expandRange(sa, sb) : testRefs;
          let total = 0;
          testRefs.forEach((ref, i) => {
            const val = getRaw(ref).trim();
            let match = false;
            if (criterion.startsWith('>=')) match = Number(val) >= Number(criterion.slice(2));
            else if (criterion.startsWith('<=')) match = Number(val) <= Number(criterion.slice(2));
            else if (criterion.startsWith('>')) match = Number(val) > Number(criterion.slice(1));
            else if (criterion.startsWith('<')) match = Number(val) < Number(criterion.slice(1));
            else match = val.toUpperCase() === criterion.toUpperCase();
            if (match && sumRefs[i]) {
              const v = evalCell(sumRefs[i], new Set(seen));
              total += Number.isFinite(v) ? v : 0;
            }
          });
          return String(total);
        });

      // === MATH FUNCTIONS ===
      safe = safe.replace(/\bROUND\(([^,)]+),([^)]+)\)/g, (_, v: string, d: string) => {
        const factor = Math.pow(10, Number(d));
        return String(Math.round(Number(evalMixed(v.trim(), new Set(seen))) * factor) / factor);
      });

      safe = safe.replace(/\bROUNDUP\(([^,)]+),([^)]+)\)/g, (_, v: string, d: string) => {
        const factor = Math.pow(10, Number(d));
        return String(Math.ceil(Number(evalMixed(v.trim(), new Set(seen))) * factor) / factor);
      });

      safe = safe.replace(/\bROUNDDOWN\(([^,)]+),([^)]+)\)/g, (_, v: string, d: string) => {
        const factor = Math.pow(10, Number(d));
        return String(Math.floor(Number(evalMixed(v.trim(), new Set(seen))) * factor) / factor);
      });

      safe = safe.replace(/\bABS\(([^)]+)\)/g, (_, v: string) =>
        String(Math.abs(Number(evalMixed(v.trim(), new Set(seen))))));

      safe = safe.replace(/\bSQRT\(([^)]+)\)/g, (_, v: string) =>
        String(Math.sqrt(Number(evalMixed(v.trim(), new Set(seen))))));

      safe = safe.replace(/\bPOWER\(([^,)]+),([^)]+)\)/g, (_, v: string, e: string) =>
        String(Math.pow(Number(evalMixed(v.trim(), new Set(seen))), Number(evalMixed(e.trim(), new Set(seen))))));

      safe = safe.replace(/\bMOD\(([^,)]+),([^)]+)\)/g, (_, v: string, d: string) =>
        String(Number(evalMixed(v.trim(), new Set(seen))) % Number(evalMixed(d.trim(), new Set(seen)))));

      safe = safe.replace(/\bFLOOR\(([^)]+)\)/g, (_, v: string) =>
        String(Math.floor(Number(evalMixed(v.trim(), new Set(seen))))));

      safe = safe.replace(/\bCEILING\(([^)]+)\)/g, (_, v: string) =>
        String(Math.ceil(Number(evalMixed(v.trim(), new Set(seen))))));

      safe = safe.replace(/\bINT\(([^)]+)\)/g, (_, v: string) =>
        String(Math.trunc(Number(evalMixed(v.trim(), new Set(seen))))));

      safe = safe.replace(/\bLN\(([^)]+)\)/g, (_, v: string) =>
        String(Math.log(Number(evalMixed(v.trim(), new Set(seen))))));

      safe = safe.replace(/\bEXP\(([^)]+)\)/g, (_, v: string) =>
        String(Math.exp(Number(evalMixed(v.trim(), new Set(seen))))));

      // LOG after LN to avoid partial match
      safe = safe.replace(/\bLOG\(([^,)]+)(?:,([^)]+))?\)/g, (_, v: string, base: string) => {
        const val = Number(evalMixed(v.trim(), new Set(seen)));
        const b = base ? Number(evalMixed(base.trim(), new Set(seen))) : 10;
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
      safe = safe.replace(/\bNOW\(\)/g, () => `"${new Date().toLocaleString()}"`);
      safe = safe.replace(/\bTODAY\(\)/g, () => `"${new Date().toLocaleDateString()}"`);
      safe = safe.replace(/\bYEAR\(([A-Z]+\d+)\)/g, (_, ref: string) =>
        String(new Date(getRaw(ref)).getFullYear()));
      safe = safe.replace(/\bMONTH\(([A-Z]+\d+)\)/g, (_, ref: string) =>
        String(new Date(getRaw(ref)).getMonth() + 1));
      safe = safe.replace(/\bDAY\(([A-Z]+\d+)\)/g, (_, ref: string) =>
        String(new Date(getRaw(ref)).getDate()));

      // === CELL REFS → numeric ===
      safe = safe.replace(/\b([A-Z]+\d+)\b/g, (_, ref: string) => {
        const v = evalCell(ref, new Set(seen));
        return Number.isFinite(v) ? String(v) : 'NaN';
      });

      // If result is a quoted string, extract it
      const strMatch = safe.match(/^"(.*)"$/s);
      if (strMatch) return strMatch[1];

      // Numeric eval - allow NaN and Infinity literals in the expression
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

  // Process IF(condition, true_val, false_val) with paren-balanced arg splitting
  function processIF(expr: string, seen: Set<string>): string {
    // Iteratively replace IF(...) from innermost outward
    let result = expr;
    let prev = '';
    while (result !== prev) {
      prev = result;
      result = result.replace(/\bIF\(([^()]*)\)/g, (_, inner: string) => {
        const args = splitArgs(inner);
        if (args.length < 2) return 'NaN';
        const cond = args[0].trim();
        const trueVal = (args[1] ?? '0').trim();
        const falseVal = (args[2] ?? '0').trim();

        let condResult: boolean;
        try {
          let condSafe = cond;
          condSafe = condSafe.replace(/\b([A-Z]+\d+)\b/g, (__, ref: string) => {
            const v = evalCell(ref, new Set(seen));
            return Number.isFinite(v) ? String(v) : '0';
          });
          // eslint-disable-next-line no-new-func
          condResult = Boolean(Function(`"use strict"; return (${condSafe});`)());
        } catch {
          condResult = false;
        }

        const branch = condResult ? trueVal : falseVal;
        const branchResult = evalMixed(branch, new Set(seen));
        return typeof branchResult === 'string' ? `"${branchResult}"` : String(branchResult);
      });
    }
    return result;
  }

  // Process IFERROR(value, error_val)
  function processIFERROR(expr: string, seen: Set<string>): string {
    let result = expr;
    let prev = '';
    while (result !== prev) {
      prev = result;
      result = result.replace(/\bIFERROR\(([^()]*)\)/g, (_, inner: string) => {
        const args = splitArgs(inner);
        if (args.length < 2) return 'NaN';
        try {
          const val = evalMixed(args[0].trim(), new Set(seen));
          if (typeof val === 'number' && isNaN(val)) {
            const errVal = evalMixed(args[1].trim(), new Set(seen));
            return typeof errVal === 'string' ? `"${errVal}"` : String(errVal);
          }
          return typeof val === 'string' ? `"${val}"` : String(val);
        } catch {
          const errVal = evalMixed(args[1].trim(), new Set(seen));
          return typeof errVal === 'string' ? `"${errVal}"` : String(errVal);
        }
      });
    }
    return result;
  }

  // Split comma-separated args respecting paren depth
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
