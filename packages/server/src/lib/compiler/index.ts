/**
 * TypeScript compiler module.
 *
 * Compiles TypeScript from sandbox directories to bundled HTML applications.
 * Uses Bun.build() and Bun.Transpiler for compilation.
 */

import { readFile, writeFile, mkdir, stat, unlink } from 'fs/promises';
import { join, resolve } from 'path';
import { execFile } from 'child_process';
import { bundledLibraryPluginBun } from './plugins.js';
import { extractProtocolFromSource } from './extract-protocol.js';
import { PROJECT_ROOT, IS_BUNDLED_EXE } from '../../config.js';
import {
  IFRAME_CAPTURE_HELPER_SCRIPT,
  IFRAME_STORAGE_SDK_SCRIPT,
  IFRAME_FETCH_PROXY_SCRIPT,
  IFRAME_APP_PROTOCOL_SCRIPT,
} from '@yaar/shared';

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

export interface TypecheckResult {
  success: boolean;
  diagnostics: string[];
}

/**
 * Get the full path to a sandbox directory.
 */
export function getSandboxPath(sandboxId: string): string {
  return join(SANDBOX_DIR, sandboxId);
}

/**
 * Minified SDK scripts cache. Populated lazily on first compile.
 */
let sdkScriptsCache: { raw: string; minified: string } | null = null;

function getRawSdkScripts(): string {
  return [
    IFRAME_CAPTURE_HELPER_SCRIPT,
    IFRAME_STORAGE_SDK_SCRIPT,
    IFRAME_FETCH_PROXY_SCRIPT,
    IFRAME_APP_PROTOCOL_SCRIPT,
  ].join('\n');
}

async function getSdkScripts(minify: boolean): Promise<string> {
  if (!sdkScriptsCache) {
    const raw = getRawSdkScripts();
    const transpiler = new Bun.Transpiler({ minifyWhitespace: true });
    const minified = transpiler.transformSync(raw).trim();
    sdkScriptsCache = { raw, minified };
  }
  return minify ? sdkScriptsCache.minified : sdkScriptsCache.raw;
}

/**
 * Escape JS code for safe embedding inside an HTML `<script>` tag.
 *
 * The HTML parser treats `</script` (case-insensitive) as a closing tag even
 * when it appears inside a JS string literal or template literal.  Replacing
 * `</script` with `<\/script` is safe because `\/` evaluates to `/` in JS
 * strings, so runtime behaviour is unchanged.
 */
function escapeInlineJs(code: string): string {
  return code.replace(/<\/script/gi, '<\\/script');
}

/**
 * Generate an HTML wrapper that embeds bundled JavaScript.
 */
export function generateHtmlWrapper(jsCode: string, title: string, sdkCode: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;overflow:hidden}body{font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}</style>
<script>${escapeInlineJs(sdkCode)}</script>
</head>
<body>
<div id="app"></div>
<script type="module">
${escapeInlineJs(jsCode)}
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
 * Bundle an entry point using Bun.build().
 */
async function compileWithBun(entryPoint: string, minify: boolean): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entryPoint],
    minify,
    format: 'esm',
    target: 'browser',
    plugins: [bundledLibraryPluginBun()],
  });

  if (!result.success) {
    const errors = result.logs
      .filter((l) => l.level === 'error')
      .map((l) => l.message || String(l));
    throw new Error(errors.join('\n') || `Bun.build() failed for ${entryPoint}`);
  }

  const output = result.outputs[0];
  if (!output) {
    throw new Error(`Bun.build() produced no output for ${entryPoint}`);
  }
  return await output.text();
}

/**
 * Compile TypeScript from a sandbox directory to a bundled HTML file.
 */
export async function compileTypeScript(
  sandboxPath: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const { minify = true, title = 'App' } = options;
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

    // Bundle TypeScript to JavaScript
    const jsCode = await compileWithBun(entryPoint, minify);

    // Get SDK scripts (minified when minify is enabled)
    const sdkCode = await getSdkScripts(minify);

    // Generate HTML wrapper with embedded JavaScript
    const htmlContent = generateHtmlWrapper(jsCode, title, sdkCode);

    // Write to dist/index.html
    await writeFile(outputPath, htmlContent, 'utf-8');

    // Extract app protocol manifest from source (best-effort)
    try {
      const sourceCode = await readFile(entryPoint, 'utf-8');
      const protocol = extractProtocolFromSource(sourceCode);
      if (protocol) {
        await writeFile(join(distDir, 'protocol.json'), JSON.stringify(protocol, null, 2), 'utf-8');
      }
    } catch {
      // Non-fatal — protocol discovery just won't be available
    }

    return {
      success: true,
      outputPath,
    };
  } catch (err) {
    return {
      success: false,
      errors: [String(err)],
    };
  }
}

const BUNDLED_TYPES_DIR = resolve(PROJECT_ROOT, 'packages/server/src/lib/bundled-types');

const TSC_PATH = resolve(PROJECT_ROOT, 'packages/server/node_modules/.bin/tsc');

/**
 * Run a loose TypeScript type check on a sandbox directory.
 *
 * Writes a temporary tsconfig, shells out to tsc --noEmit, then cleans up.
 */
export async function typecheckSandbox(sandboxPath: string): Promise<TypecheckResult> {
  // tsc is not available in bundled exe mode (no node_modules)
  if (IS_BUNDLED_EXE) {
    return { success: true, diagnostics: [] };
  }

  const tsconfigPath = join(sandboxPath, 'tsconfig.typecheck.json');

  const tsconfig = {
    compilerOptions: {
      strict: false,
      noEmit: true,
      target: 'ES2022',
      module: 'ES2022',
      moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      types: [],
      paths: {
        '@bundled/*': [join(BUNDLED_TYPES_DIR, '*')],
      },
      skipLibCheck: true,
    },
    include: ['src/**/*.ts'],
  };

  await writeFile(tsconfigPath, JSON.stringify(tsconfig, null, 2), 'utf-8');

  try {
    const output = await new Promise<string>((res, rej) => {
      execFile(
        TSC_PATH,
        ['--noEmit', '-p', tsconfigPath],
        { cwd: sandboxPath, timeout: 30_000 },
        (err, stdout, stderr) => {
          // tsc exits non-zero when there are diagnostics — that's not a
          // process error, so we always resolve with the combined output.
          if (err && !('code' in err && typeof err.code === 'number')) {
            rej(err);
            return;
          }
          res((stdout + '\n' + stderr).trim());
        },
      );
    });

    if (!output) {
      return { success: true, diagnostics: [] };
    }

    const diagnostics = output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    return { success: false, diagnostics };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, diagnostics: [`tsc process error: ${msg}`] };
  } finally {
    await unlink(tsconfigPath).catch(() => {});
  }
}
