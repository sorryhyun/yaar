/**
 * TypeScript compiler module.
 *
 * Compiles TypeScript from sandbox directories to bundled HTML applications.
 * Uses Bun.build() and Bun.Transpiler for compilation.
 */

import { mkdir, stat } from 'fs/promises';
import { join } from 'path';
import { buildAppBundle, formatBuildLogs } from './build/build-app.js';
import { AppSourceCache } from './build/source-cache.js';
import { formatProtocolError } from './protocol/extract-protocol-ast.js';
import { extractProtocolFromDir } from './protocol/extract-protocol-dir.js';
import { getCompilerConfig } from './config.js';
import {
  computeSourceHash,
  computeAppJsonHash,
  writeBuildManifest,
  COMPILER_VERSION,
} from './build/build-manifest.js';
import {
  IFRAME_IME_GUARD_SCRIPT,
  IFRAME_CAPTURE_HELPER_SCRIPT,
  IFRAME_STORAGE_SDK_SCRIPT,
  IFRAME_VERB_SDK_SCRIPT,
  IFRAME_FETCH_PROXY_SCRIPT,
  IFRAME_APP_PROTOCOL_SCRIPT,
  IFRAME_CONTEXTMENU_SCRIPT,
  IFRAME_NOTIFICATIONS_SDK_SCRIPT,
  IFRAME_WINDOWS_SDK_SCRIPT,
  IFRAME_CONSOLE_CAPTURE_SCRIPT,
  FONT_SANS,
} from '@yaar/shared';
import { YAAR_DESIGN_TOKENS_CSS } from './design-tokens.js';
import {
  scanTokens,
  formatTokenFindings,
  type AppSourceFile,
} from './guards/design-token-guard.js';
import { APP_MOUNT_ID } from './guards/mount-guard.js';

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

/**
 * app.json's `"links"` — what an app declares about the links in its own content,
 * handed to the SDK as `window.__yaar_links__`.
 *
 * Declarative because it is provenance, not behavior: `base` says which site this
 * app's content came from, which is the one thing the link guard cannot infer and
 * had to be told (a root-relative href in a GitHub README means github.com, not the
 * YAAR shell that is serving the app). Anything that needs a *decision* is
 * `links.onOpen` in app code instead, where the app can act on it.
 */
export interface AppLinkConfig {
  /** Origin (or full URL) RELATIVE hrefs in this app's content resolve against. */
  base?: string;
}

/**
 * Read `links` from the app.json beside `src/`. Absent, malformed, or carrying a
 * `base` that is not a parseable absolute URL all yield `{}` — a link policy is a
 * convenience, and a typo in it must not fail a build that would otherwise ship.
 */
async function readLinkConfig(sandboxPath: string): Promise<AppLinkConfig> {
  try {
    const json = JSON.parse(await Bun.file(join(sandboxPath, 'app.json')).text());
    const base = json?.links?.base;
    if (typeof base !== 'string' || !base) return {};
    const parsed = new URL(base);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return {};
    return { base: parsed.href };
  } catch {
    return {};
  }
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
 * Minified SDK scripts cache. Populated lazily on first compile. Only the
 * minified form is cached — the raw form is an array join.
 */
let minifiedSdkScripts: string | null = null;

function getRawSdkScripts(): string {
  return [
    // First — the guard must be listening before any app code registers handlers
    IFRAME_IME_GUARD_SCRIPT,
    IFRAME_CAPTURE_HELPER_SCRIPT,
    IFRAME_STORAGE_SDK_SCRIPT,
    IFRAME_VERB_SDK_SCRIPT,
    IFRAME_FETCH_PROXY_SCRIPT,
    IFRAME_APP_PROTOCOL_SCRIPT,
    // Baked in rather than injected, because `IframeRenderer` can only inject into a
    // **same-origin** frame and an origin-isolated app (`source: 'user'`) is not one.
    // Without it such an app forwarded none of the shell's reserved shortcuts, so
    // Shift+Tab fell through to the browser's own focus walk inside the frame — the
    // CLI panel never opened and focus moved to the next control instead. Idempotent
    // (`installGuard`), so a bundled app that also gets the injected copy is unharmed.
    IFRAME_CONTEXTMENU_SCRIPT,
    IFRAME_NOTIFICATIONS_SDK_SCRIPT,
    IFRAME_WINDOWS_SDK_SCRIPT,
    IFRAME_CONSOLE_CAPTURE_SCRIPT,
  ].join('\n');
}

function getSdkScripts(minify: boolean): string {
  if (!minify) return getRawSdkScripts();
  if (minifiedSdkScripts === null) {
    const transpiler = new Bun.Transpiler({ minifyWhitespace: true });
    minifiedSdkScripts = transpiler.transformSync(getRawSdkScripts()).trim();
  }
  return minifiedSdkScripts;
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
  links: AppLinkConfig = {},
): string {
  const manifestScript = manifest
    ? `\n<script>window.__yaar_manifest__=${escapeInlineJs(JSON.stringify(manifest))};</script>`
    : '';
  // Always emitted, empty or not. Besides carrying app.json's "links", its mere
  // presence is how the link guard tells a compiled app from a plain HTML document
  // that happens to be shown in a window — the one must not navigate its own frame,
  // the other must keep browsing in place.
  const linksScript = `\n<script>window.__yaar_links__=${escapeInlineJs(JSON.stringify(links))};</script>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${YAAR_DESIGN_TOKENS_CSS}*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;overflow:hidden;background:var(--yaar-bg)}#${APP_MOUNT_ID}{height:100%}#${APP_MOUNT_ID}:empty{display:none}body{font-family:${FONT_SANS}}</style>
${linksScript}
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
  bundles: string[] | undefined,
  sources: AppSourceCache,
): Promise<string> {
  const result = await buildAppBundle(entryPoint, { minify, bundles, sources });

  if (!result.success) {
    const errors = formatBuildLogs(result.logs, {
      includeWarnings: true,
      withPosition: true,
      fallbackFile: entryPoint,
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
function readAppSources(sources: AppSourceCache): AppSourceFile[] {
  return [...sources.collect(TOKEN_SCAN_EXTENSIONS)].map(([path, text]) => ({ path, text }));
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

  // One read of each source file for the whole compile: the token guard, the
  // bundler's source hook, and protocol extraction all go through it. Scoped to
  // this call on purpose -- see `source-cache.ts`.
  const sources = new AppSourceCache(join(sandboxPath, 'src'));

  try {
    // Ensure dist directory exists
    await mkdir(distDir, { recursive: true });

    // Reject tokens that can never resolve, before paying for a bundle.
    // (The mount guard runs inside solidHtmlSourcePlugin, which already has the
    // parsed source of every reachable file.)
    const tokenFindings = scanTokens(readAppSources(sources));
    if (tokenFindings.length > 0) throw new Error(formatTokenFindings(tokenFindings));

    // Bundle TypeScript to JavaScript
    const jsCode = await compileWithBun(entryPoint, minify, options.bundles, sources);

    // Protocol gate — after bundling so genuine build errors keep precedence.
    // A registration whose commands/state only partially parse used to write a
    // silently truncated dist/protocol.json while every other signal stayed
    // green (one real incident: 29 commands shrank to 3). An entry the
    // extractor cannot resolve fails the build instead of shipping a manifest
    // missing commands.
    // `appId` is left out on purpose: `extractProtocolFromDir` derives it from
    // the app.json beside `src/`, so the `defineApp({ id })` check holds for the
    // deploy and tooling callers too, not only for a compile that passes it.
    const extraction = await extractProtocolFromDir(join(sandboxPath, 'src'), {
      bundles: options.bundles,
      sources,
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
    const sdkCode = getSdkScripts(minify);

    // Generate HTML wrapper with embedded JavaScript
    const htmlContent = generateHtmlWrapper(
      jsCode,
      title,
      sdkCode,
      extraction.protocol ?? undefined,
      await readLinkConfig(sandboxPath),
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
