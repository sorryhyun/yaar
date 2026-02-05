/**
 * TypeScript compiler for sandbox execution.
 *
 * Uses esbuild's transform API for fast in-memory compilation.
 */

import * as esbuild from 'esbuild';

export interface CompileResult {
  success: boolean;
  code?: string;
  errors?: string[];
}

/**
 * Compile TypeScript code to JavaScript using esbuild transform API.
 *
 * This doesn't require any file system access - it compiles in memory.
 */
export async function compileTypeScript(code: string): Promise<CompileResult> {
  try {
    const result = await esbuild.transform(code, {
      loader: 'ts',
      format: 'cjs', // CommonJS for vm execution
      target: 'es2022',
      logLevel: 'silent',
    });

    if (result.warnings.length > 0) {
      // Warnings don't prevent execution but we can log them
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
      errors: [err instanceof Error ? err.message : 'Unknown compilation error'],
    };
  }
}

/**
 * Wrap code in an IIFE that captures the return value.
 *
 * This allows users to write `return value` at the top level.
 */
export function wrapCodeForExecution(code: string): string {
  // Check if code already has a return statement at top level
  // If not, we'll try to return the last expression
  return `(function() {
${code}
})()`;
}
