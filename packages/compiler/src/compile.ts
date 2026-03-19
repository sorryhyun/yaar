/**
 * TypeScript compiler module.
 *
 * Compiles TypeScript from sandbox directories to bundled HTML applications.
 * Uses Bun.build() and Bun.Transpiler for compilation.
 */

import { mkdir, stat } from 'fs/promises';
import { join } from 'path';
import {
  bundledLibraryPluginBun,
  cssFilePlugin,
  solidHtmlClosingTagPlugin,
  toForwardSlash,
} from './plugins.js';
import { extractProtocolFromSource } from './extract-protocol.js';
import { getCompilerConfig } from './config.js';
import {
  IFRAME_CAPTURE_HELPER_SCRIPT,
  IFRAME_STORAGE_SDK_SCRIPT,
  IFRAME_VERB_SDK_SCRIPT,
  IFRAME_FETCH_PROXY_SCRIPT,
  IFRAME_APP_PROTOCOL_SCRIPT,
  IFRAME_NOTIFICATIONS_SDK_SCRIPT,
  IFRAME_WINDOWS_SDK_SCRIPT,
  IFRAME_CONSOLE_CAPTURE_SCRIPT,
  YAAR_DESIGN_TOKENS_CSS,
} from '@yaar/shared';

/**
 * Get the sandbox directory path.
 */
export function getSandboxDir(): string {
  return join(getCompilerConfig().projectRoot, 'sandbox');
}

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
  return join(getSandboxDir(), sandboxId);
}

/**
 * Minified SDK scripts cache. Populated lazily on first compile.
 */
let sdkScriptsCache: { raw: string; minified: string } | null = null;

function getRawSdkScripts(): string {
  return [
    IFRAME_CAPTURE_HELPER_SCRIPT,
    IFRAME_STORAGE_SDK_SCRIPT,
    IFRAME_VERB_SDK_SCRIPT,
    IFRAME_FETCH_PROXY_SCRIPT,
    IFRAME_APP_PROTOCOL_SCRIPT,
    IFRAME_NOTIFICATIONS_SDK_SCRIPT,
    IFRAME_WINDOWS_SDK_SCRIPT,
    IFRAME_CONSOLE_CAPTURE_SCRIPT,
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
<style>${YAAR_DESIGN_TOKENS_CSS}*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;overflow:hidden}#app{height:100%}#app:empty{display:none}body{font-family:'NanumSquareNeo',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}</style>
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
    entrypoints: [toForwardSlash(entryPoint)],
    minify,
    format: 'esm',
    target: 'browser',
    plugins: [bundledLibraryPluginBun(), cssFilePlugin(), solidHtmlClosingTagPlugin()],
  });

  if (!result.success) {
    const errors = result.logs
      .filter((l) => l.level === 'error' || l.level === 'warning')
      .map((l) => {
        const pos = l.position;
        const loc = pos ? `${pos.file ?? entryPoint}:${pos.line}:${pos.column}: ` : '';
        return `${loc}${l.message || String(l)}`;
      });
    throw new Error(errors.join('\n') || `Bun.build() failed for ${entryPoint}`);
  }

  const output = result.outputs[0];
  if (!output) {
    throw new Error(`Bun.build() produced no output for ${entryPoint}`);
  }
  return await output.text();
}

/**
 * Extract protocol manifest from src/main.ts or src/protocol.ts.
 */
async function extractProtocolFromDir(
  srcDir: string,
): Promise<ReturnType<typeof extractProtocolFromSource>> {
  for (const file of ['main.ts', 'protocol.ts']) {
    try {
      const source = await Bun.file(join(srcDir, file)).text();
      const protocol = extractProtocolFromSource(source);
      if (protocol) return protocol;
    } catch {
      continue;
    }
  }
  return null;
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
    await Bun.write(outputPath, htmlContent);

    // Extract app protocol manifest from source (best-effort).
    // Check main.ts first, then scan all src/*.ts files for .register() calls.
    try {
      const protocol = await extractProtocolFromDir(join(sandboxPath, 'src'));
      if (protocol) {
        await Bun.write(join(distDir, 'protocol.json'), JSON.stringify(protocol, null, 2));
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
