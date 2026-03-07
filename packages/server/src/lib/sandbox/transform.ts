/**
 * TypeScript compiler for sandbox execution.
 *
 * Uses Bun.Transpiler for fast in-memory compilation.
 */

export interface CompileResult {
  success: boolean;
  code?: string;
  errors?: string[];
}

/**
 * Compile TypeScript code to JavaScript.
 */
export function compileTypeScript(code: string): CompileResult {
  try {
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    const result = transpiler.transformSync(code);
    return { success: true, code: result };
  } catch (err) {
    return {
      success: false,
      errors: [String(err)],
    };
  }
}

/**
 * Keywords that begin statement-level constructs (not expressions).
 */
const STATEMENT_START =
  /^(var|let|const|if|else|for|while|do|switch|try|catch|finally|throw|class|function|import|export|debugger|with|return)\b/;

/**
 * Check whether a code fragment looks like an expression (not a statement/declaration).
 */
function isExpression(code: string): boolean {
  const trimmed = code.trim();
  return trimmed.length > 0 && trimmed !== '}' && !STATEMENT_START.test(trimmed);
}

/**
 * Find the position of the last statement boundary (`;` or `\n`) at
 * depth 0 (not inside parens/brackets/braces/strings) that is followed
 * by non-empty code.
 */
function findLastStatementBoundary(code: string): number {
  let lastPos = -1;
  let depth = 0;
  let inString: string | null = null;

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];

    // Skip escape sequences inside strings
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }

    // Enter string
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }

    // Track nesting depth
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    // At top level, `;` and `\n` are statement boundaries
    if (depth === 0 && (ch === ';' || ch === '\n')) {
      const rest = code.slice(i + 1).trim();
      if (rest) lastPos = i;
    }
  }

  return lastPos;
}

/**
 * Wrap code in an async IIFE that captures the return value.
 *
 * This allows users to write `return value` and use `await` at the top level.
 * If the last statement is an expression (not a declaration or control flow),
 * it is auto-returned so bare expressions produce a result — like a REPL.
 */
export function wrapCodeForExecution(code: string): string {
  const trimmed = code.trimEnd();

  // Try to auto-return the last expression
  const boundary = findLastStatementBoundary(trimmed);

  if (boundary >= 0) {
    const before = trimmed.slice(0, boundary + 1);
    const lastExpr = trimmed.slice(boundary + 1).trim();
    if (lastExpr && isExpression(lastExpr)) {
      return `(async function() {\n${before}\nreturn (${lastExpr})\n})()`;
    }
  } else if (isExpression(trimmed)) {
    // Single expression with no separators
    return `(async function() {\nreturn (${trimmed})\n})()`;
  }

  return `(async function() {\n${trimmed}\n})()`;
}
