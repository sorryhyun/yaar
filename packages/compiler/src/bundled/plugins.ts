/**
 * Bun plugins for the app compiler.
 *
 * Four `onResolve`/`onLoad` hooks, and nothing else: `@bundled/*` resolution,
 * CSS-as-`<style>`, binary assets as `data:` URIs, and the solid-js/html source
 * rewrite that also runs the two runtime-contract guards. *What* the bundled
 * libraries are lives in `registry.ts`; how one is described to an agent lives in
 * `describe-library.ts`.
 *
 * In bundled exe mode, libraries resolve from embedded or disk-based pre-bundled
 * files. In dev mode, they resolve from node_modules via Bun.resolveSync().
 */

import { dirname, join } from 'path';
import { MODULE_ROOT, SHIMS_DIR } from '../paths.js';
import { scanSourceFile, formatFindings } from '../guards/solid-html-guard.js';
import { scanMountTargetsIn, formatMountFindings } from '../guards/mount-guard.js';
import { loadTypeScript } from '../load-typescript.js';
import { createAppSourceFile } from '../guards/guard-report.js';
import { readThrough, type AppSourceCache } from '../build/source-cache.js';
import {
  BUNDLED_LIBRARIES,
  BUNDLED_SHIMS,
  CONDITIONAL_EXPORT_LIBS,
  GATED_BUNDLED_LIBRARIES,
  resolveBrowserEntry,
  toForwardSlash,
} from './registry.js';

const DEBUG_BUNDLED_LIBRARIES = process.env.YAAR_DEBUG_BUNDLED_LIBS === '1';

function debugBundledLibrary(message: string): void {
  if (DEBUG_BUNDLED_LIBRARIES) console.log(message);
}

/**
 * The libraries `build-exe-bundle.js` embedded into the standalone binary, or
 * undefined outside it. Every resolution strategy consults this first, so its
 * presence is also how the plugins know they are running inside the exe.
 */
function getEmbeddedLibs(): Record<string, string> | undefined {
  return (globalThis as Record<string, unknown>).__YAAR_BUNDLED_LIBS as
    | Record<string, string>
    | undefined;
}

/** True inside the standalone exe, where shim `.ts` sources are not on disk. */
function isExeMode(): boolean {
  return getEmbeddedLibs() !== undefined;
}

/**
 * Resolve an npm package to a browser build under `node_modules`, or null.
 *
 * The ladder is `resolveBrowserEntry` (reads the exports map) then
 * `Bun.resolveSync` (runtime conditions), and the SSR rejection between them is
 * why it belongs in one place: on Windows the first step can fail while the
 * second picks the node condition, handing an app `solid-js/dist/server.js` — a
 * second, non-reactive runtime, with no build signal. Both callers need that
 * guard, and it must not end up in only one of them.
 *
 * `label` names the import in the debug log. `null` means unresolved; each
 * caller decides what that costs.
 */
function resolveNpmBrowserPath(npmName: string, label: string): string | null {
  const browserPath = resolveBrowserEntry(npmName, MODULE_ROOT);
  if (browserPath) {
    debugBundledLibrary(`[bundled-lib] ${label} → browser entry ${browserPath}`);
    return browserPath;
  }

  try {
    const resolved = toForwardSlash(Bun.resolveSync(npmName, MODULE_ROOT));
    if (CONDITIONAL_EXPORT_LIBS.includes(npmName) && resolved.includes('/server.')) {
      debugBundledLibrary(`[bundled-lib] ${label} → REJECTED SSR build ${resolved}`);
      return null;
    }
    debugBundledLibrary(`[bundled-lib] ${label} → Bun.resolveSync ${resolved}`);
    return resolved;
  } catch {
    return null;
  }
}

/**
 * Bun plugin that resolves @bundled/* imports.
 *
 * Resolution strategies (in order):
 * 1. **Embedded** (exe): Libraries embedded via `with { type: "file" }`,
 *    available as globalThis.__YAAR_BUNDLED_LIBS = { 'uuid': '/$bunfs/...', ... }.
 * 2. **Disk**: Libraries read from `bundled-libs/` directory next to the exe (fallback).
 * 3. **node_modules** (dev): Resolves browser entry from package.json exports,
 *    falling back to Bun.resolveSync() for packages without conditional exports.
 */
export function bundledLibraryPluginBun(allowedBundles?: string[]): Bun.BunPlugin {
  // Log bundled libs state once at plugin creation time
  const embeddedLibsSnapshot = getEmbeddedLibs();
  debugBundledLibrary(
    `[bundled-lib] plugin init: __YAAR_BUNDLED_LIBS is ${
      embeddedLibsSnapshot === undefined
        ? 'undefined'
        : `set (${Object.keys(embeddedLibsSnapshot).length} libs: ${Object.keys(embeddedLibsSnapshot).slice(0, 5).join(', ')}...)`
    }, MODULE_ROOT=${MODULE_ROOT}, SHIMS_DIR=${SHIMS_DIR}`,
  );

  return {
    name: 'bundled-libraries-bun',
    setup(build: Bun.PluginBuilder) {
      const NAMESPACE = 'bundled-lib';

      build.onResolve({ filter: /^@bundled\// }, (args: Bun.OnResolveArgs) => {
        const libName = args.path.replace('@bundled/', '');
        if (!(libName in BUNDLED_LIBRARIES)) {
          const available = Object.keys(BUNDLED_LIBRARIES).join(', ');
          throw new Error(`Unknown bundled library: "${libName}". Available: ${available}`);
        }
        // Gate yaar-* extended SDKs — require explicit declaration in app.json bundles
        if (GATED_BUNDLED_LIBRARIES.includes(libName)) {
          if (!allowedBundles?.includes(libName)) {
            throw new Error(
              `"@bundled/${libName}" requires "${libName}" in app.json bundles field. ` +
                `Add "bundles": ["${libName}"] to your app.json to use this SDK.`,
            );
          }
        }
        // Strategy 1: embedded libs (production exe) — checked first because
        // shim source paths don't exist inside the bundled executable.
        const embeddedLibs = getEmbeddedLibs();
        if (embeddedLibs?.[libName]) {
          debugBundledLibrary(
            `[bundled-lib] @bundled/${libName} → embedded (namespace=${NAMESPACE})`,
          );
          return { path: libName, namespace: NAMESPACE };
        }

        // Strategy 0: local shim file (wraps npm package with compat fixes).
        // Skip in exe mode — shim .ts sources aren't usable as Bun.build() input
        // inside the embedded filesystem (paths like B:/~BUN/root/shims/yaar.ts).
        // In exe mode, shims are pre-bundled and must be in __YAAR_BUNDLED_LIBS.
        if (BUNDLED_SHIMS[libName] && !isExeMode()) {
          debugBundledLibrary(`[bundled-lib] @bundled/${libName} → shim ${BUNDLED_SHIMS[libName]}`);
          return { path: BUNDLED_SHIMS[libName] };
        }

        // Strategy 3: node_modules (dev). Unresolved falls through to the
        // namespace, where onLoad tries the disk-based exe layout.
        const resolved = resolveNpmBrowserPath(BUNDLED_LIBRARIES[libName], `@bundled/${libName}`);
        if (resolved) return { path: resolved };

        debugBundledLibrary(
          `[bundled-lib] @bundled/${libName} → fallback namespace (will try disk/embedded in onLoad)`,
        );
        return { path: libName, namespace: NAMESPACE };
      });

      // Intercept bare solid-js imports from within bundled libraries (e.g.,
      // solid-js/html imports solid-js/web, solid-js/web imports solid-js).
      // Without this, Bun's default resolver may pick different paths (e.g., dev
      // builds or symlinked paths) causing duplicate module copies with separate
      // reactive runtimes that break solid-js's signal tracking.
      build.onResolve({ filter: /^solid-js(\/|$)/ }, (args: Bun.OnResolveArgs) => {
        const libName = args.path as string;
        if (!CONDITIONAL_EXPORT_LIBS.includes(libName)) return undefined;

        // In exe mode, redirect to the prebundled lib (embedded or disk).
        // The prebundled solid-js sub-packages (html, web, store) have solid-js
        // marked as external, so their bare `import 'solid-js'` statements need
        // to resolve to the shared prebundled bundle.
        const embeddedLibs = getEmbeddedLibs();
        if (embeddedLibs?.[libName]) {
          debugBundledLibrary(
            `[bundled-lib] bare ${libName} (from ${args.importer}) → embedded (namespace=${NAMESPACE})`,
          );
          return { path: libName, namespace: NAMESPACE };
        }

        // Dev mode: resolve browser entry from node_modules. Unresolved hands the
        // import back to Bun's default resolver.
        const label = `bare ${libName} (from ${args.importer})`;
        const resolved = resolveNpmBrowserPath(libName, label);
        if (resolved) return { path: resolved };

        debugBundledLibrary(`[bundled-lib] ${label} → UNRESOLVED (returning undefined)`);
        return undefined;
      });

      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, async (args: Bun.OnLoadArgs) => {
        const libName = args.path;

        // Strategy 1: embedded libs (production exe)
        const embeddedLibs = getEmbeddedLibs();
        if (embeddedLibs?.[libName]) {
          const filePath = embeddedLibs[libName];
          debugBundledLibrary(`[bundled-lib] onLoad ${libName} → embedded file ${filePath}`);
          const contents = await Bun.file(filePath).text();
          debugBundledLibrary(`[bundled-lib] onLoad ${libName} → loaded ${contents.length} chars`);
          return { contents, loader: 'js' };
        }

        // Strategy 2: disk libs (dev exe) — bundled-libs/ next to executable
        const exeDir = toForwardSlash(dirname(process.execPath));
        const diskPath = toForwardSlash(join(exeDir, 'bundled-libs', `${libName}.js`));
        const diskFile = Bun.file(diskPath);
        if (await diskFile.exists()) {
          debugBundledLibrary(`[bundled-lib] onLoad ${libName} → disk file ${diskPath}`);
          const contents = await diskFile.text();
          debugBundledLibrary(`[bundled-lib] onLoad ${libName} → loaded ${contents.length} chars`);
          return { contents, loader: 'js' };
        }

        debugBundledLibrary(
          `[bundled-lib] onLoad ${libName} → NOT FOUND (embedded=${embeddedLibs !== undefined}, diskPath=${diskPath})`,
        );
        throw new Error(
          `Bundled library "${libName}" not found. ` +
            `Looked for embedded lib and disk file at ${diskPath}. ` +
            `Ensure the library is installed as a devDependency.`,
        );
      });
    },
  };
}

/**
 * Bun plugin that converts `.css` file imports into JS modules
 * that inject a <style> element at runtime.
 *
 * Also resolves bare CSS imports from bundled library packages
 * (e.g. `diff2html/bundles/css/diff2html.min.css`) which can't
 * be found by Bun's default resolver in exe mode.
 */
export function cssFilePlugin(): Bun.BunPlugin {
  return {
    name: 'css-file-loader',
    setup(build: Bun.PluginBuilder) {
      const CSS_NAMESPACE = 'bundled-css';

      // Resolve bare CSS imports from bundled library packages.
      // In exe mode, these are pre-bundled as JS style-injector modules
      // in __YAAR_BUNDLED_LIBS. In dev mode, resolve from compiler's node_modules.
      build.onResolve({ filter: /\.css$/ }, (args: Bun.OnResolveArgs) => {
        // Only handle bare imports (package paths), not relative/absolute
        if (args.path.startsWith('.') || args.path.startsWith('/')) return undefined;

        // Check if this is from a known bundled library
        const matchingLib = Object.keys(BUNDLED_LIBRARIES).find(
          (name) => args.path === name || args.path.startsWith(name + '/'),
        );
        if (!matchingLib) return undefined;

        // Exe mode: check embedded CSS libs (pre-bundled as JS style-injectors)
        if (getEmbeddedLibs()?.[args.path]) {
          return { path: args.path, namespace: CSS_NAMESPACE };
        }

        // Dev mode: resolve from compiler's node_modules
        try {
          return { path: toForwardSlash(Bun.resolveSync(args.path, MODULE_ROOT)) };
        } catch {
          return undefined;
        }
      });

      // Load pre-bundled CSS-as-JS from embedded libs (exe mode)
      build.onLoad({ filter: /.*/, namespace: CSS_NAMESPACE }, async (args: Bun.OnLoadArgs) => {
        const embeddedLibs = getEmbeddedLibs();
        if (embeddedLibs?.[args.path]) {
          const contents = await Bun.file(embeddedLibs[args.path]).text();
          return { contents, loader: 'js' };
        }
        throw new Error(`Bundled CSS "${args.path}" not found in embedded libs`);
      });

      // Convert .css files to JS style-injector modules (dev mode)
      build.onLoad({ filter: /\.css$/ }, async (args: Bun.OnLoadArgs) => {
        const css = await Bun.file(toForwardSlash(args.path)).text();
        const escaped = css.replace(/`/g, '\\`').replace(/\$/g, '\\$');
        return {
          contents: `{const s=document.createElement('style');s.textContent=\`${escaped}\`;document.head.appendChild(s);}`,
          loader: 'js',
        };
      });
    },
  };
}

/**
 * Static-asset extensions inlined as base64 `data:` URIs, mapped to their MIME
 * type. A YAAR app compiles to a single self-contained HTML file, so an imported
 * binary can't ship as a sibling file — it has to be baked into the bundle.
 */
export const ASSET_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const ASSET_FILTER = new RegExp(
  `\\.(${Object.keys(ASSET_MIME_TYPES)
    .map((ext) => ext.slice(1))
    .join('|')})$`,
  'i',
);

/**
 * Bun plugin that inlines imported binary assets as base64 `data:` URIs.
 *
 * `import logo from './logo.png'` resolves the default export to a data-URI
 * string usable in `<img src>`, CSS `url()`, `fetch()`, `new Audio()`, etc.
 *
 * Why a plugin and not `Bun.build({ loader: { '.png': 'dataurl' } })`: the
 * `dataurl`/`base64` loader values are silently a no-op in Bun's *programmatic*
 * bundler (1.3.14) — they emit an empty string. Inlining only works through the
 * HTML-entrypoint pipeline, which YAAR doesn't use (its wrapper is synthesized
 * with ordered SDK injection). Bun's default loader for these extensions is
 * `file`, which emits a *sibling* asset the single-HTML output would drop. This
 * `onLoad` hook reads the bytes and returns them inline, so nothing escapes the
 * one file.
 */
export function assetDataUrlPlugin(): Bun.BunPlugin {
  return {
    name: 'asset-dataurl-loader',
    setup(build: Bun.PluginBuilder) {
      build.onLoad({ filter: ASSET_FILTER }, async (args: Bun.OnLoadArgs) => {
        const dot = args.path.lastIndexOf('.');
        const ext = args.path.slice(dot).toLowerCase();
        const mime = ASSET_MIME_TYPES[ext] ?? 'application/octet-stream';
        const bytes = await Bun.file(toForwardSlash(args.path)).arrayBuffer();
        const url = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
        return { contents: `export default ${JSON.stringify(url)};`, loader: 'js' };
      });
    },
  };
}

/**
 * Bun plugin that validates and rewrites solid-js/html source in one file read.
 *
 * `</${Show}>` produces an extra expression that the html runtime parser never
 * consumes, shifting later expression indices. Replacing it with `</>` is safe
 * because solid-js/html only decrements nesting depth for closing tags; it does
 * not compare their names.
 *
 * The guard detects templates tagged literally as `html` and intentionally does
 * not trace the tag back to its import. The fast check also assumes the current
 * `html\`` spelling (no whitespace before the backtick). All bundled apps follow
 * that convention; changing it requires updating this gate and its tests.
 *
 * `typescript` is a devDependency and is absent in bundled-exe mode, so the
 * specifier is assembled at runtime. When unavailable, the guard is skipped but
 * the closing-tag rewrite still runs.
 */
export function solidHtmlSourcePlugin(sources?: AppSourceCache): Bun.BunPlugin {
  const loadTs = loadTypeScript;

  return {
    name: 'solid-html-source',
    setup(build: Bun.PluginBuilder) {
      build.onLoad({ filter: /\.tsx?$/ }, async (args: Bun.OnLoadArgs) => {
        const filePath = toForwardSlash(args.path);
        // Through the compile's cache when there is one: the token guard read
        // most of these files already, and this hook must still return the
        // (possibly rewritten) contents either way.
        const text = await readThrough(sources, filePath);
        const rewritten = text.replace(/<\/\$\{([^}]+)\}>/g, '</>');

        // Cheap text gates so the TS parser only runs on files that could match.
        const mayHaveTemplates = text.includes('html`');
        const mayMount = text.includes('render(');
        if (mayHaveTemplates || mayMount) {
          const ts = await loadTs();
          if (ts) {
            // One parse for both guards — a file that matches both gates used to
            // be handed to `ts.createSourceFile` twice over identical text.
            const sourceFile = createAppSourceFile(ts, filePath, rewritten);
            if (mayHaveTemplates) {
              const findings = scanSourceFile(ts, sourceFile);
              if (findings.length > 0) throw new Error(formatFindings(filePath, findings));
            }
            if (mayMount) {
              const mounts = scanMountTargetsIn(ts, sourceFile);
              if (mounts.length > 0) throw new Error(formatMountFindings(filePath, mounts));
            }
          }
        }

        if (rewritten === text) return undefined;
        return {
          contents: rewritten,
          loader: filePath.endsWith('.tsx') ? 'tsx' : 'ts',
        };
      });
    },
  };
}
