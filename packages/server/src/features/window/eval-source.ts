/**
 * Turn what an agent writes into a preview eval into something the iframe can run.
 *
 * The iframe runs the expression with an indirect `eval` — a classic *script*, in the
 * global scope. Two things an agent writes by habit are syntax errors there, and both
 * came back from previews as a bare `SyntaxError` with nothing pointing at the cause:
 *
 * - **TypeScript.** The agent spends its turn writing app source, so an eval reads like
 *   it: `(document.querySelector('.row') as HTMLElement).offsetHeight`, `__debug.doc!.id`.
 * - **Top-level `await`.** `await fetch(...)` is legal in a module and in a console, not in
 *   a script.
 *
 * So, only when the expression does *not* already parse as JavaScript: strip the types,
 * and if what remains still needs an async context, run it in one and hand back the value
 * of its last expression — the completion value a plain eval would have returned. An
 * expression that parses is passed through byte for byte, so nothing that worked before
 * can change meaning. One that cannot be repaired is also passed through unchanged, so
 * the iframe reports the error in the code the agent actually wrote.
 *
 * Inside the async wrapper a `const` is local to the call rather than a global lexical
 * binding the next eval can see. That only reaches code that used to fail outright.
 */

const transpiler = new Bun.Transpiler({
  loader: 'ts',
  // The completion value is the whole point of an eval, and dead-code elimination drops
  // exactly that: `1; 2` and a bare arrow function both transpile to nothing.
  deadCodeElimination: false,
  trimUnusedImports: false,
});

/**
 * Does `source` parse as a function body? Close to "as a script": a body also admits
 * `return` (which the async wrapper relies on) and, like a script, refuses top-level
 * `await`. The function is constructed for its early errors and never called.
 */
function parses(source: string): boolean {
  try {
    new Function(source);
    return true;
  } catch {
    return false;
  }
}

/** Parses inside an async function — i.e. it needs an async context and has one there. */
function parsesAsync(body: string): boolean {
  return parses(`return (async () => {\n${body}\n});`);
}

/**
 * The body with its last statement returned, when that statement is an expression.
 *
 * Bun prints every top-level statement starting at column 0, so the last statement starts
 * on one of the column-0 lines; walking them back from the end, the first tail that parses
 * as a single parenthesized expression is it. A tail that starts mid-statement does not
 * parse that way, and a declaration never does — that case keeps its explicit `return`.
 */
function returnLastExpression(code: string): string | null {
  const lines = code.replace(/\s+$/, '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s/.test(lines[i]) || !lines[i]) continue;
    const tail = lines.slice(i).join('\n').replace(/;$/, '');
    const candidate = [...lines.slice(0, i), `return (${tail});`].join('\n');
    if (parsesAsync(candidate)) return candidate;
  }
  return null;
}

export function prepareEvalExpression(expression: string): string {
  if (parses(expression)) return expression;

  let code: string;
  try {
    code = transpiler.transformSync(expression);
  } catch {
    // The transpiler refuses a top-level `return`, which the async wrapper is exactly what
    // makes legal — so JavaScript that only needs the wrapper goes in as written.
    code = expression;
  }
  if (parses(code)) return code;
  if (!parsesAsync(code)) return expression;

  const body = returnLastExpression(code) ?? code;
  return `(async () => {\n${body}\n})()`;
}
