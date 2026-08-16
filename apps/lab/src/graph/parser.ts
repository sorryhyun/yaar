// Pratt-ish recursive descent parser for graph expressions.
//
// Two things it does that a plain calculator parser does not:
//   * implicit multiplication — `2x`, `3cos(t)`, `x(x+1)` all parse as products,
//     decided by `startsFactor()` looking at whether the next token could begin a
//     factor at all.
//   * `|...|` is absolute value, lowered to a call to `abs`.
//
// Precedence, loosest first: + -   *  /  (and juxtaposition)   unary -   ^ (right
// associative, binding tighter than unary so -x^2 is -(x^2)).

import { tokenize, type Token } from './lexer';

export type Node =
  | { k: 'num'; v: number }
  | { k: 'var'; n: string }
  | { k: 'neg'; a: Node }
  | { k: '+' | '-' | '*' | '/' | '^'; a: Node; b: Node }
  | { k: 'call'; n: string; args: Node[] };

/** Parse one expression source into an AST. Throws with a readable message. */
export function parse(src: string): Node {
  const ts: Token[] = tokenize(src);
  let p = 0;

  const peek = (): Token | undefined => ts[p];
  const eat = (v: string): boolean => {
    const x = ts[p];
    if (x && x.t === 'op' && x.v === v) {
      p++;
      return true;
    }
    return false;
  };

  function startsFactor(): boolean {
    const x = peek();
    if (!x) return false;
    if (x.t === 'num' || x.t === 'id') return true;
    return x.t === 'op' && (x.v === '(' || x.v === '|');
  }

  function expr(): Node {
    let n = term();
    for (;;) {
      if (eat('+')) n = { k: '+', a: n, b: term() };
      else if (eat('-')) n = { k: '-', a: n, b: term() };
      else return n;
    }
  }

  function term(): Node {
    let n = unary();
    for (;;) {
      if (eat('*')) n = { k: '*', a: n, b: unary() };
      else if (eat('/')) n = { k: '/', a: n, b: unary() };
      else if (startsFactor()) n = { k: '*', a: n, b: unary() };
      else return n;
    }
  }

  function unary(): Node {
    if (eat('-')) return { k: 'neg', a: unary() };
    if (eat('+')) return unary();
    return power();
  }

  function power(): Node {
    const b = primary();
    if (eat('^')) return { k: '^', a: b, b: unary() };
    return b;
  }

  function primary(): Node {
    const x = peek();
    if (!x) throw new Error('unexpected end of expression');
    if (x.t === 'num') {
      p++;
      return { k: 'num', v: x.v };
    }
    if (x.t === 'id') {
      p++;
      const nx = peek();
      if (nx && nx.t === 'op' && nx.v === '(') {
        p++;
        const args: Node[] = [expr()];
        while (eat(',')) args.push(expr());
        if (!eat(')')) throw new Error('missing )');
        return { k: 'call', n: x.v, args };
      }
      return { k: 'var', n: x.v };
    }
    if (eat('(')) {
      const e = expr();
      if (!eat(')')) throw new Error('missing )');
      return e;
    }
    if (eat('|')) {
      const e = expr();
      if (!eat('|')) throw new Error('missing |');
      return { k: 'call', n: 'abs', args: [e] };
    }
    throw new Error('unexpected "' + String(x.v) + '"');
  }

  const e = expr();
  if (p < ts.length) throw new Error('trailing input near "' + String(ts[p].v) + '"');
  return e;
}
