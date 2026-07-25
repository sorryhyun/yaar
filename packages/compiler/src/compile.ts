/**
 * TypeScript compiler module.
 *
 * Compiles TypeScript from sandbox directories to bundled HTML applications.
 * Uses Bun.build() and Bun.Transpiler for compilation.
 */

import { mkdir, readdir, stat } from 'fs/promises';
import { join } from 'path';
import {
  bundledLibraryPluginBun,
  cssFilePlugin,
  assetDataUrlPlugin,
  solidHtmlSourcePlugin,
  toForwardSlash,
} from './plugins.js';
import { formatProtocolError } from './extract-protocol-ast.js';
import { extractProtocolFromDir } from './extract-protocol-dir.js';
import { getCompilerConfig } from './config.js';
import {
  computeSourceHash,
  computeAppJsonHash,
  writeBuildManifest,
  COMPILER_VERSION,
} from './build-manifest.js';
import {
  IFRAME_IME_GUARD_SCRIPT,
  IFRAME_CAPTURE_HELPER_SCRIPT,
  IFRAME_STORAGE_SDK_SCRIPT,
  IFRAME_VERB_SDK_SCRIPT,
  IFRAME_FETCH_PROXY_SCRIPT,
  IFRAME_APP_PROTOCOL_SCRIPT,
  IFRAME_NOTIFICATIONS_SDK_SCRIPT,
  IFRAME_WINDOWS_SDK_SCRIPT,
  IFRAME_CONSOLE_CAPTURE_SCRIPT,
  FONT_SANS,
} from '@yaar/shared';
import { YAAR_DESIGN_TOKENS_CSS } from './design-tokens.js';
import { scanTokens, formatTokenFindings, type AppSourceFile } from './design-token-guard.js';
import { APP_MOUNT_ID } from './mount-guard.js';

/**
 * Get the sandbox directory path.
 */
export function getSandboxDir(): string {
  return join(getCompilerConfig().projectRoot, 'sandbox');
}

export interface CompileOptions {
  minify?: boolean;
  title?: string;
  /** Allowed yaar-* bundle names from app.json. Gates @bundled/yaar-dev, @bundled/yaar-web, etc. */
  bundles?: string[];
}

export interface CompileResult {
  success: boolean;
  outputPath?: string;
  errors?: string[];
  /** Key names written to dist/protocol.json, when the app registers a protocol. */
  protocol?: { commands: string[]; state: string[] };
}

/**
 * Get the full path to a sandbox directory.
 */
export function getSandboxPath(sandboxId: string): string {
  if (!/^(?!\.\.?$)[A-Za-z0-9._-]+$/.test(sandboxId)) {
    throw new Error(`Invalid sandbox id: ${JSON.stringify(sandboxId)}`);
  }
  return join(getSandboxDir(), sandboxId);
}

/** Soft ceiling for a compiled app's single HTML file before we warn (5MB). */
const LARGE_BUNDLE_WARN_BYTES = 5_000_000;

/**
 * Minified SDK scripts cache. Populated lazily on first compile.
 */
let sdkScriptsCache: { raw: string; minified: string } | null = null;

function getRawSdkScripts(): string {
  return [
    // First — the guard must be listening before any app code registers handlers
    IFRAME_IME_GUARD_SCRIPT,
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
 *
 * `manifest` is the protocol this build extracted, handed back to the running
 * app as `window.__yaar_manifest__`. It exists because a Zod `params` is a
 * schema *object* at runtime, not JSON Schema, and the SDK has no way to convert
 * one — the conversion happened here, at build time, with the app's own zod. By
 * giving the folded result back, the manifest the iframe serves and the manifest
 * on disk are the same bytes by construction rather than by agreement. Apps that
 * declare plain literals get an identical copy of what they already had.
 */
export function generateHtmlWrapper(
  jsCode: string,
  title: string,
  sdkCode: string,
  manifest?: object,
): string {
  const manifestScript = manifest
    ? `\n<script>window.__yaar_manifest__=${escapeInlineJs(JSON.stringify(manifest))};</script>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${YAAR_DESIGN_TOKENS_CSS}*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;overflow:hidden;background:var(--yaar-bg)}#${APP_MOUNT_ID}{height:100%}#${APP_MOUNT_ID}:empty{display:none}body{font-family:${FONT_SANS}}</style>
<script>${escapeInlineJs(sdkCode)}</script>${manifestScript}
</head>
<body>
<div id="${APP_MOUNT_ID}"></div>
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
async function compileWithBun(
  entryPoint: string,
  minify: boolean,
  bundles?: string[],
): Promise<string> {
  const result = await Bun.build({
    entrypoints: [toForwardSlash(entryPoint)],
    minify,
    format: 'esm',
    target: 'browser',
    // Resolve with { success: false, logs } instead of throwing, so errors
    // keep their file/line/column positions (the catch path loses them).
    throw: false,
    plugins: [
      bundledLibraryPluginBun(bundles),
      cssFilePlugin(),
      assetDataUrlPlugin(),
      solidHtmlSourcePlugin(),
    ],
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

/** Source extensions that can reference a design token — TS (inline styles) and CSS alike. */
const TOKEN_SCAN_EXTENSIONS = /\.(tsx?|css)$/;

/**
 * Read every source file of an app, for checks that need a whole-app view.
 *
 * The design token guard is one: an app may declare `--yaar-card-bg` in
 * `theme.css` and use it in `main.ts`, and a per-file scan would call that
 * undefined. Reading the directory (rather than following imports) also covers
 * `.css` files, which the bundler hands to a different loader.
 */
async function readAppSources(srcDir: string): Promise<AppSourceFile[]> {
  const entries = await readdir(srcDir, { recursive: true });
  const files = entries.filter((rel) => TOKEN_SCAN_EXTENSIONS.test(rel));
  return Promise.all(
    files.map(async (rel) => ({
      path: join('src', rel),
      text: await Bun.file(join(srcDir, rel)).text(),
    })),
  );
}

/**
 * Read the app's declared id from `app.json`.
 *
 * `defineApp({ id })` is checked against it: the id is what the app registers
 * under at runtime and what `protocol.json` is filed against, so the two
 * disagreeing produces a manifest nothing else keys on. A sandbox with no
 * app.json (a scratch compile) has no id to disagree with — undefined skips the
 * check rather than failing a build that is not wrong about anything.
 */
async function readAppId(sandboxPath: string): Promise<string | undefined> {
  try {
    const json = JSON.parse(await Bun.file(join(sandboxPath, 'app.json')).text());
    const id = json?.appId;
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
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

    // Reject tokens that can never resolve, before paying for a bundle.
    // (The mount guard runs inside solidHtmlSourcePlugin, which already has the
    // parsed source of every reachable file.)
    const tokenFindings = scanTokens(await readAppSources(join(sandboxPath, 'src')));
    if (tokenFindings.length > 0) throw new Error(formatTokenFindings(tokenFindings));

    // Bundle TypeScript to JavaScript
    const jsCode = await compileWithBun(entryPoint, minify, options.bundles);

    // Protocol gate — after bundling so genuine build errors keep precedence.
    // A register() whose commands/state only partially parse used to write a
    // silently truncated dist/protocol.json while every other signal stayed
    // green (one real incident: 29 commands shrank to 3). An entry the
    // extractor cannot resolve fails the build instead of shipping a manifest
    // missing commands.
    const extraction = await extractProtocolFromDir(join(sandboxPath, 'src'), {
      appId: await readAppId(sandboxPath),
      bundles: options.bundles,
    });
    if (extraction.errors.length > 0) {
      return {
        success: false,
        errors: [
          'Protocol extraction failed - the manifest would silently drop entries:',
          ...extraction.errors.map(formatProtocolError),
          'Every state key and command must be statically resolvable, or an agent cannot ' +
            'see it. Descriptors may live in other files and arrive via `...spread`, but ' +
            'each one must resolve to an object literal reached through relative imports.',
        ],
      };
    }
    // Get SDK scripts (minified when minify is enabled)
    const sdkCode = await getSdkScripts(minify);

    // Generate HTML wrapper with embedded JavaScript
    const htmlContent = generateHtmlWrapper(
      jsCode,
      title,
      sdkCode,
      extraction.protocol ?? undefined,
    );

    // A YAAR app compiles to one self-contained HTML the frontend loads into an
    // iframe; `dataurl`-inlined assets (fonts, images, wasm) land here at +33%
    // over their raw size. Warn past a soft ceiling so a heavyweight asset shows
    // up at build time rather than as a sluggish window.
    const bundleBytes = Buffer.byteLength(htmlContent, 'utf8');
    if (bundleBytes > LARGE_BUNDLE_WARN_BYTES) {
      console.warn(
        `[compiler] Large app bundle: ${(bundleBytes / 1_000_000).toFixed(1)}MB for ${title}. ` +
          `Imported binary assets are base64-inlined (~33% overhead); consider fetching large ` +
          `media at runtime instead of importing it.`,
      );
    }

    // Write to dist/index.html
    await Bun.write(outputPath, htmlContent);

    // Write the extracted protocol manifest (validated by the gate above)
    if (extraction.protocol) {
      await Bun.write(join(distDir, 'protocol.json'), JSON.stringify(extraction.protocol, null, 2));
    }

    // Write build manifest for change detection
    try {
      const [sourceHash, appJsonHash] = await Promise.all([
        computeSourceHash(sandboxPath),
        computeAppJsonHash(sandboxPath),
      ]);
      await writeBuildManifest(sandboxPath, {
        sourceHash,
        appJsonHash,
        compilerVersion: COMPILER_VERSION,
        compiledAt: new Date().toISOString(),
      });
    } catch {
      // Non-fatal — auto-compile will just recompile next time
    }

    return {
      success: true,
      outputPath,
      ...(extraction.protocol
        ? {
            protocol: {
              commands: Object.keys(extraction.protocol.commands),
              state: Object.keys(extraction.protocol.state),
            },
          }
        : {}),
    };
  } catch (err) {
    let errors: string[];
    if (err instanceof AggregateError && err.errors?.length) {
      // BuildMessage/ResolveMessage carry a .position that String() discards
      errors = err.errors.map((e: unknown) => {
        const pos = (e as { position?: { file?: string; line?: number; column?: number } })
          ?.position;
        const msg = e instanceof Error ? e.message : String(e);
        return pos?.file ? `${pos.file}:${pos.line}:${pos.column}: ${msg}` : msg;
      });
    } else {
      errors = [err instanceof Error ? err.message : String(err)];
    }
    return {
      success: false,
      errors,
    };
  }
}
