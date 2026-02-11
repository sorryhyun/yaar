/**
 * TypeScript compiler for sandbox execution.
 *
 * Uses esbuild's transform API for fast in-memory compilation.
 * Falls back to Bun.Transpiler when running as a bundled exe.
 */

import { IS_BUNDLED_EXE } from '../../config.js';

export interface CompileResult {
  success: boolean;
  code?: string;
  errors?: string[];
}

/**
 * Compile TypeScript code to JavaScript.
 *
 * - Bundled exe: uses Bun.Transpiler (no external binary needed)
 * - Development: uses esbuild.transform()
 */
export async function compileTypeScript(code: string): Promise<CompileResult> {
  if (IS_BUNDLED_EXE) {
    return compileWithBunTranspiler(code);
  }
  return compileWithEsbuild(code);
}

function compileWithBunTranspiler(code: string): CompileResult {
  try {
    const BunApi = (globalThis as any).Bun;
    const transpiler = new BunApi.Transpiler({ loader: 'ts' });
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
      format: 'cjs', // CommonJS for vm execution
      target: 'es2022',
      logLevel: 'silent',
    });

    if (result.warnings.length > 0) {
      const warnings = result.warnings.map((w) => w.text);
      return {
        success: true,
        code: result.code,
        errors: warnings.map((w) => `Warning: ${w}`),
      };
    }

    return {
      success: true,
      code: result.code,
    };
  } catch (err) {
    if (err instanceof Error && 'errors' in err) {
      const esbuildErr = err as { errors: Array<{ text: string; location?: { line: number; column: number } }> };
      const errors = esbuildErr.errors.map((e) => {
        if (e.location) {
          return `Line ${e.location.line}:${e.location.column}: ${e.text}`;
        }
        return e.text;
      });
      return {
        success: false,
        errors,
      };
    }

    return {
      success: false,
      errors: [String(err)],
    };
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
