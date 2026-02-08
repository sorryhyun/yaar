/**
 * TypeScript compiler module.
 *
 * Compiles TypeScript from sandbox directories to bundled HTML applications
 * using esbuild for fast compilation.
 */

import * as esbuild from 'esbuild';
import { writeFile, mkdir, stat } from 'fs/promises';
import { join } from 'path';
import { bundledLibraryPlugin } from './plugins.js';
import { PROJECT_ROOT } from '../../config.js';

const SANDBOX_DIR = join(PROJECT_ROOT, 'sandbox');

export { SANDBOX_DIR };

export interface CompileOptions {
  minify?: boolean;
  title?: string;
}

export interface CompileResult {
  success: boolean;
  outputPath?: string;
  errors?: string[];
}

/**
 * Get the full path to a sandbox directory.
 */
export function getSandboxPath(sandboxId: string): string {
  return join(SANDBOX_DIR, sandboxId);
}

/**
 * Generate an HTML wrapper that embeds bundled JavaScript.
 */
export function generateHtmlWrapper(jsCode: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  </style>
</head>
<body>
  <script type="module">
${jsCode}
  </script>
</body>
</html>`;
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Compile TypeScript from a sandbox directory to a bundled HTML file.
 */
export async function compileTypeScript(
  sandboxPath: string,
  options: CompileOptions = {}
): Promise<CompileResult> {
  const { minify = false, title = 'App' } = options;
  const entryPoint = join(sandboxPath, 'src', 'main.ts');
  const distDir = join(sandboxPath, 'dist');
  const outputPath = join(distDir, 'index.html');

  try {
    // Verify entry point exists
    await stat(entryPoint);
  } catch {
    return {
      success: false,
      errors: [`Entry point not found: src/main.ts`],
    };
  }

  try {
    // Ensure dist directory exists
    await mkdir(distDir, { recursive: true });

    // Bundle TypeScript to JavaScript using esbuild
    const result = await esbuild.build({
      entryPoints: [entryPoint],
      bundle: true,
      minify,
      format: 'esm',
      target: ['es2020'],
      write: false,
      sourcemap: false,
      logLevel: 'silent',
      plugins: [bundledLibraryPlugin()],
    });

    if (result.errors.length > 0) {
      return {
        success: false,
        errors: result.errors.map((e: { text: string }) => e.text),
      };
    }

    // Get the bundled JavaScript
    const jsCode = result.outputFiles?.[0]?.text ?? '';

    // Generate HTML wrapper with embedded JavaScript
    const htmlContent = generateHtmlWrapper(jsCode, title);

    // Write to dist/index.html
    await writeFile(outputPath, htmlContent, 'utf-8');

    return {
      success: true,
      outputPath,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return {
      success: false,
      errors: [error],
    };
  }
}
