// AST -> closure, plus the form dispatch that decides what kind of curve a source
// string describes. Everything here is pure and main-thread: the kernel ships
// expression *strings*, and this is where they become functions, in the renderer,
// which is what makes re-sampling on zoom possible at all.

import { parse, type Node } from './parser';

export type Scope = Record<string, number>;
export type Fn = (s: Scope) => number;

export const CONST: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
  phi: (1 + Math.sqrt(5)) / 2,
};

type AnyFn = (...args: number[]) => number;

export const FN: Record<string, AnyFn> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log2: Math.log2,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  min: Math.min,
  max: Math.max,
  mod: (a: number, b: number) => ((a % b) + b) % b,
  atan2: Math.atan2,
  hypot: Math.hypot,
  nthroot: (x: number, n: number) => Math.sign(x) * Math.pow(Math.abs(x), 1 / n),
};

/** Every name a graph expression may call, for docs and error messages. */
export const FN_NAMES = Object.keys(FN).sort();
/** The variables a sampler binds itself — never turned into a slider. */
export const BOUND_VARS = ['x', 'y', 't', 'theta'];

/** Turn an AST into a closure over a scope object. */
export function compile(n: Node): Fn {
  switch (n.k) {
    case 'num': {
      const v = n.v;
      return () => v;
    }
    case 'var': {
      if (n.n in CONST) {
        const v = CONST[n.n];
        return () => v;
      }
      const k = n.n;
      return (s) => s[k];
    }
    case 'neg': {
      const a = compile(n.a);
      return (s) => -a(s);
    }
    case '+': {
      const a = compile(n.a),
        b = compile(n.b);
      return (s) => a(s) + b(s);
    }
    case '-': {
      const a = compile(n.a),
        b = compile(n.b);
      return (s) => a(s) - b(s);
    }
    case '*': {
      const a = compile(n.a),
        b = compile(n.b);
      return (s) => a(s) * b(s);
    }
    case '/': {
      const a = compile(n.a),
        b = compile(n.b);
      return (s) => a(s) / b(s);
    }
    case '^': {
      const a = compile(n.a),
        b = compile(n.b);
      // Odd roots of negative numbers: (-8)^(1/3) is -2, not NaN.
      return (s) => {
        const x = a(s),
          y = b(s);
        if (x < 0 && Number.isInteger(1 / y)) return Math.sign(x) * Math.pow(-x, y);
        return Math.pow(x, y);
      };
    }
    case 'call': {
      const f = FN[n.n];
      if (!f) throw new Error('unknown function ' + n.n);
      const as = n.args.map(compile);
      if (as.length === 1) {
        const a = as[0];
        return (s) => f(a(s));
      }
      if (as.length === 2) {
        const a = as[0],
          b = as[1];
        return (s) => f(a(s), b(s));
      }
      return (s) => f(...as.map((g) => g(s)));
    }
  }
}

/** Every free variable in an AST — named constants excluded. */
export function freeVars(n: Node, out?: Set<string>): Set<string> {
  const set = out || new Set<string>();
  if (n.k === 'var' && !(n.n in CONST)) set.add(n.n);
  if (n.k === 'neg') freeVars(n.a, set);
  if (n.k === '+' || n.k === '-' || n.k === '*' || n.k === '/' || n.k === '^') {
    freeVars(n.a, set);
    freeVars(n.b, set);
  }
  if (n.k === 'call') n.args.forEach((a) => freeVars(a, set));
  return set;
}

/** Split on the first occurrence of `ch` at paren depth 0. */
export function splitTop(src: string, ch: string): [string, string] | null {
  let d = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '(') d++;
    else if (c === ')') d--;
    else if (c === ch && d === 0) return [src.slice(0, i), src.slice(i + 1)];
  }
  return null;
}

export type Compiled =
  | { type: 'explicit'; f: Fn; free: Set<string> }
  | { type: 'explicitX'; f: Fn; free: Set<string> }
  | { type: 'polar'; f: Fn; free: Set<string> }
  | { type: 'implicit'; f: Fn; free: Set<string> }
  | { type: 'param'; fx: Fn; fy: Fn; free: Set<string> };

/**
 * Decide which form a source string is and compile it.
 *
 *   (fx, fy)          parametric in t
 *   y = ...           explicit
 *   x = ...           explicit, sampled down the y axis
 *   r = ...           polar in theta
 *   f(x,y) = g(x,y)   implicit, drawn by marching squares over f - g
 *   ...               bare expression, same as y = ...
 */
export function buildExpr(raw: string): Compiled {
  const src = (raw || '').trim();
  if (!src) throw new Error('empty expression');

  if (src[0] === '(' && src[src.length - 1] === ')') {
    const parts = splitTop(src.slice(1, -1), ',');
    if (parts) {
      const ax = parse(parts[0]);
      const ay = parse(parts[1]);
      return {
        type: 'param',
        fx: compile(ax),
        fy: compile(ay),
        free: new Set([...freeVars(ax), ...freeVars(ay)]),
      };
    }
  }

  const eq = splitTop(src, '=');
  if (!eq) {
    const a = parse(src);
    return { type: 'explicit', f: compile(a), free: freeVars(a) };
  }

  const lhs = eq[0].trim();
  const rhs = eq[1].trim();
  if (lhs === 'y') {
    const a = parse(rhs);
    return { type: 'explicit', f: compile(a), free: freeVars(a) };
  }
  if (lhs === 'x') {
    const a = parse(rhs);
    return { type: 'explicitX', f: compile(a), free: freeVars(a) };
  }
  if (lhs === 'r') {
    const a = parse(rhs);
    return { type: 'polar', f: compile(a), free: freeVars(a) };
  }

  const A = parse(lhs),
    B = parse(rhs);
  const fa = compile(A),
    fb = compile(B);
  return {
    type: 'implicit',
    f: (s) => fa(s) - fb(s),
    free: new Set([...freeVars(A), ...freeVars(B)]),
  };
}

/** Free variables that should become sliders: everything the samplers do not bind. */
export function sliderVars(compiled: (Compiled | null)[]): string[] {
  const used = new Set<string>();
  for (const c of compiled) {
    if (!c) continue;
    c.free.forEach((v) => {
      if (!BOUND_VARS.includes(v)) used.add(v);
    });
  }
  return [...used].sort();
}
