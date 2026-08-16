// Tokenizer for the graphing expression language. Deliberately tiny: numbers,
// identifiers, and the eight operator characters the parser understands.

export type Token = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

const OPS = '+-*/^(),|';

/** Split an expression source into tokens. Throws on any character it cannot place. */
export function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const raw = s.slice(i, j);
      const v = parseFloat(raw);
      if (!isFinite(v)) throw new Error('bad number "' + raw + '"');
      out.push({ t: 'num', v });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z_0-9]/.test(s[j])) j++;
      out.push({ t: 'id', v: s.slice(i, j) });
      i = j;
      continue;
    }
    if (OPS.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new Error('unexpected "' + c + '"');
  }
  return out;
}
