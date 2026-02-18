/**
 * TypeScript compiler for sandbox execution.
 *
 * Uses Bun.Transpiler for fast in-memory compilation.
 * Falls back to esbuild when Bun is not available (e.g. vitest under Node).
 */

export interface CompileResult {
  success: boolean;
  code?: string;
  errors?: string[];
}

/**
 * Compile TypeScript code to JavaScript.
 */
export async function compileTypeScript(code: string): Promise<CompileResult> {
  if (typeof Bun !== 'undefined') {
    return compileWithBunTranspiler(code);
  }
  return compileWithEsbuild(code);
}

function compileWithBunTranspiler(code: string): CompileResult {
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

async function compileWithEsbuild(code: string): Promise<CompileResult> {
  const esbuild = await import('esbuild');
  try {
    const result = await esbuild.transform(code, {
      loader: 'ts',
      format: 'cjs',
      target: 'es2022',
      logLevel: 'silent',
    });
    return { success: true, code: result.code };
  } catch (err) {
    if (err instanceof Error && 'errors' in err) {
      const esbuildErr = err as {
        errors: Array<{ text: string; location?: { line: number; column: number } }>;
      };
      const errors = esbuildErr.errors.map((e) => {
        if (e.location) {
          return `Line ${e.location.line}:${e.location.column}: ${e.text}`;
        }
        return e.text;
      });
      return { success: false, errors };
    }
    return { success: false, errors: [String(err)] };
  }
}

/**
 * Wrap code in an async IIFE that captures the return value.
 *
 * This allows users to write `return value` and use `await` at the top level.
 */
export function wrapCodeForExecution(code: string): string {
  return `(async function() {
${code}
})()`;
}
