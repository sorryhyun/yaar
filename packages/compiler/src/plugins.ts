/**
 * Bun plugins for the app compiler.
 *
 * Provides bundled library support via @bundled/* imports.
 * In bundled exe mode, resolves from embedded or disk-based pre-bundled files.
 * In dev mode, resolves from node_modules via Bun.resolveSync().
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * Normalize a file path to use forward slashes.
 * On Windows, path.join/resolve produce backslashes which can cause
 * Bun.build() plugin resolution failures ("AggregateError: Bundle failed").
 */
export const toForwardSlash = (p: string): string => p.replace(/\\/g, '/');

/** Directory of this file — inside packages/compiler, where devDependencies are installed. */
const PLUGIN_DIR = toForwardSlash(dirname(fileURLToPath(import.meta.url)));

/**
 * Shim source directory — always points to src/shims/ regardless of whether
 * this code runs from src/ (dev) or dist/ (built). Shim files are .ts sources
 * consumed by Bun.build(), so they must resolve to the original source location.
 */
const SHIMS_DIR = toForwardSlash(join(PLUGIN_DIR.replace(/\/dist$/, '/src'), 'shims'));

/**
 * Local shim files that wrap npm libraries with compatibility fixes.
 * When a @bundled/* import matches a shim, it resolves to the shim file
 * instead of the npm package directly.
 */
export const BUNDLED_SHIMS: Record<string, string> = {
  anime: toForwardSlash(join(SHIMS_DIR, 'anime.ts')),
  yaar: toForwardSlash(join(SHIMS_DIR, 'yaar.ts')),
  'yaar-dev': toForwardSlash(join(SHIMS_DIR, 'yaar-dev.ts')),
  'yaar-web': toForwardSlash(join(SHIMS_DIR, 'yaar-web.ts')),
};

/**
 * Libraries with browser/node conditional exports that need consistent resolution.
 * Bare imports of these from within bundled code must resolve to the same path as
 * the @bundled/* aliased imports to prevent duplicate module copies.
 */
const CONDITIONAL_EXPORT_LIBS = ['solid-js', 'solid-js/web', 'solid-js/html', 'solid-js/store'];

/**
 * Map of @bundled/* import names to actual npm module paths.
 * These libraries are installed as devDependencies and bundled into apps.
 * `null` = internal library (resolved from server source, not npm).
 */
export const BUNDLED_LIBRARIES: Record<string, string> = {
  'solid-js': 'solid-js',
  'solid-js/html': 'solid-js/html',
  'solid-js/web': 'solid-js/web',
  'solid-js/store': 'solid-js/store',
  uuid: 'uuid',
  lodash: 'lodash-es',
  'date-fns': 'date-fns',
  clsx: 'clsx',
  anime: 'animejs',
  konva: 'konva',
  three: 'three',
  'cannon-es': 'cannon-es',
  xlsx: '@e965/xlsx',
  'chart.js': 'chart.js',
  d3: 'd3',
  diff: 'diff',
  diff2html: 'diff2html',
  'matter-js': 'matter-js',
  tone: 'tone',
  'pixi.js': 'pixi.js',
  p5: 'p5',
  mammoth: 'mammoth',
  marked: 'marked',
  prismjs: 'prismjs',
  yaar: 'yaar',
  'yaar-dev': 'yaar-dev',
  'yaar-web': 'yaar-web',
};

/**
 * Resolve a npm package to its browser entry point by reading package.json exports.
 *
 * Bun.resolveSync() uses runtime (node/bun) conditions, which for packages like
 * solid-js resolves to the SSR build (dist/server.js) instead of the browser build
 * (dist/solid.js). This helper reads the exports map and picks the browser condition.
 */
export function resolveBrowserEntry(npmName: string, fromDir: string): string | null {
  // Split 'solid-js/web' → pkg='solid-js', subpath='./web'
  const parts = npmName.split('/');
  const isScoped = npmName.startsWith('@');
  const pkgName = isScoped ? parts.slice(0, 2).join('/') : parts[0];
  const subpath =
    parts.length > (isScoped ? 2 : 1) ? './' + parts.slice(isScoped ? 2 : 1).join('/') : '.';

  try {
    const pkgJsonPath = Bun.resolveSync(`${pkgName}/package.json`, fromDir);
    const pkgDir = toForwardSlash(dirname(pkgJsonPath));
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));

    const exportEntry = pkgJson.exports?.[subpath];
    if (!exportEntry) return null;

    // Prefer browser > default import condition.
    // The browser condition can be a string or nested object with import/default.
    const browser = exportEntry.browser;
    if (browser) {
      const entry = typeof browser === 'string' ? browser : (browser.import ?? browser.default);
      if (entry) return toForwardSlash(join(pkgDir, entry));
    }

    // Fallback: use the top-level import/default condition.
    // For solid-js, the top-level `import` points to the browser build (dist/solid.js),
    // while node/worker/deno conditions point to server.js. If the browser condition
    // failed to resolve (e.g. on Windows where Bun.resolveSync may behave differently),
    // the top-level import is still the correct browser build.
    const topImport = exportEntry.import ?? exportEntry.default;
    if (typeof topImport === 'string' && !topImport.includes('server')) {
      return toForwardSlash(join(pkgDir, topImport));
    }

    return null;
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
  const embeddedLibsSnapshot = (globalThis as Record<string, unknown>).__YAAR_BUNDLED_LIBS as
    | Record<string, string>
    | undefined;
  console.log(
    `[bundled-lib] plugin init: __YAAR_BUNDLED_LIBS is ${
      embeddedLibsSnapshot === undefined
        ? 'undefined'
        : `set (${Object.keys(embeddedLibsSnapshot).length} libs: ${Object.keys(embeddedLibsSnapshot).slice(0, 5).join(', ')}...)`
    }, PLUGIN_DIR=${PLUGIN_DIR}, SHIMS_DIR=${SHIMS_DIR}`,
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
        if (libName.startsWith('yaar-')) {
          if (!allowedBundles?.includes(libName)) {
            throw new Error(
              `"@bundled/${libName}" requires "${libName}" in app.json bundles field. ` +
                `Add "bundles": ["${libName}"] to your app.json to use this SDK.`,
            );
          }
        }
        // Strategy 1: embedded libs (production exe) — checked first because
        // shim source paths don't exist inside the bundled executable.
        const embeddedLibs = (globalThis as Record<string, unknown>).__YAAR_BUNDLED_LIBS as
          | Record<string, string>
          | undefined;
        if (embeddedLibs?.[libName]) {
          console.log(`[bundled-lib] @bundled/${libName} → embedded (namespace=${NAMESPACE})`);
          return { path: libName, namespace: NAMESPACE };
        }

        // Strategy 0: local shim file (wraps npm package with compat fixes).
        // Skip in exe mode — shim .ts sources aren't usable as Bun.build() input
        // inside the embedded filesystem (paths like B:/~BUN/root/shims/yaar.ts).
        // In exe mode, shims are pre-bundled and must be in __YAAR_BUNDLED_LIBS.
        const isExeMode = embeddedLibs !== undefined;
        if (BUNDLED_SHIMS[libName] && !isExeMode) {
          console.log(`[bundled-lib] @bundled/${libName} → shim ${BUNDLED_SHIMS[libName]}`);
          return { path: BUNDLED_SHIMS[libName] };
        }

        // Strategy 3: node_modules (dev) — first try browser-aware resolution
        // (Bun.resolveSync uses runtime/node conditions which gives SSR builds
        // for packages like solid-js), then fall back to Bun.resolveSync for
        // packages without conditional exports.
        const npmName = BUNDLED_LIBRARIES[libName];
        const browserPath = resolveBrowserEntry(npmName, PLUGIN_DIR);
        if (browserPath) {
          console.log(`[bundled-lib] @bundled/${libName} → browser entry ${browserPath}`);
          return { path: browserPath };
        }

        try {
          const resolved = toForwardSlash(Bun.resolveSync(npmName, PLUGIN_DIR));
          // Guard: reject SSR builds for libs with browser/node conditional exports.
          // On Windows, resolveBrowserEntry can fail while Bun.resolveSync picks the
          // node condition (e.g. solid-js/dist/server.js instead of dist/solid.js).
          if (CONDITIONAL_EXPORT_LIBS.includes(npmName) && resolved.includes('/server.')) {
            console.log(`[bundled-lib] @bundled/${libName} → REJECTED SSR build ${resolved}`);
            throw new Error(`Resolved SSR build for ${npmName}, need browser build`);
          }
          console.log(`[bundled-lib] @bundled/${libName} → Bun.resolveSync ${resolved}`);
          return { path: resolved };
        } catch {
          // fall through to namespace for disk-based resolution
        }

        console.log(
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
        const embeddedLibs = (globalThis as Record<string, unknown>).__YAAR_BUNDLED_LIBS as
          | Record<string, string>
          | undefined;
        if (embeddedLibs?.[libName]) {
          console.log(
            `[bundled-lib] bare ${libName} (from ${args.importer}) → embedded (namespace=${NAMESPACE})`,
          );
          return { path: libName, namespace: NAMESPACE };
        }

        // Dev mode: resolve browser entry from node_modules
        const browserPath = resolveBrowserEntry(libName, PLUGIN_DIR);
        if (browserPath) {
          console.log(
            `[bundled-lib] bare ${libName} (from ${args.importer}) → browser entry ${browserPath}`,
          );
          return { path: browserPath };
        }
        try {
          const resolved = toForwardSlash(Bun.resolveSync(libName, PLUGIN_DIR));
          // Reject SSR builds — see guard in @bundled/* resolver above
          if (resolved.includes('/server.')) {
            console.log(
              `[bundled-lib] bare ${libName} (from ${args.importer}) → REJECTED SSR build ${resolved}`,
            );
            return undefined;
          }
          console.log(
            `[bundled-lib] bare ${libName} (from ${args.importer}) → Bun.resolveSync ${resolved}`,
          );
          return { path: resolved };
        } catch {
          console.log(
            `[bundled-lib] bare ${libName} (from ${args.importer}) → UNRESOLVED (returning undefined)`,
          );
          return undefined;
        }
      });

      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, async (args: Bun.OnLoadArgs) => {
        const libName = args.path;

        // Strategy 1: embedded libs (production exe)
        const embeddedLibs = (globalThis as Record<string, unknown>).__YAAR_BUNDLED_LIBS as
          | Record<string, string>
          | undefined;
        if (embeddedLibs?.[libName]) {
          const filePath = embeddedLibs[libName];
          console.log(`[bundled-lib] onLoad ${libName} → embedded file ${filePath}`);
          const contents = await Bun.file(filePath).text();
          console.log(`[bundled-lib] onLoad ${libName} → loaded ${contents.length} chars`);
          return { contents, loader: 'js' };
        }

        // Strategy 2: disk libs (dev exe) — bundled-libs/ next to executable
        const exeDir = toForwardSlash(dirname(process.execPath));
        const diskPath = toForwardSlash(join(exeDir, 'bundled-libs', `${libName}.js`));
        const diskFile = Bun.file(diskPath);
        if (await diskFile.exists()) {
          console.log(`[bundled-lib] onLoad ${libName} → disk file ${diskPath}`);
          const contents = await diskFile.text();
          console.log(`[bundled-lib] onLoad ${libName} → loaded ${contents.length} chars`);
          return { contents, loader: 'js' };
        }

        console.log(
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
        const embeddedLibs = (globalThis as Record<string, unknown>).__YAAR_BUNDLED_LIBS as
          | Record<string, string>
          | undefined;
        if (embeddedLibs?.[args.path]) {
          return { path: args.path, namespace: CSS_NAMESPACE };
        }

        // Dev mode: resolve from compiler's node_modules
        try {
          return { path: toForwardSlash(Bun.resolveSync(args.path, PLUGIN_DIR)) };
        } catch {
          return undefined;
        }
      });

      // Load pre-bundled CSS-as-JS from embedded libs (exe mode)
      build.onLoad({ filter: /.*/, namespace: CSS_NAMESPACE }, async (args: Bun.OnLoadArgs) => {
        const embeddedLibs = (globalThis as Record<string, unknown>).__YAAR_BUNDLED_LIBS as
          | Record<string, string>
          | undefined;
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
 * Bun plugin that strips expressions from closing component tags in
 * solid-js/html tagged template literals.
 *
 * `</${Show}>` produces an extra expression that the html runtime parser
 * never consumes, shifting all subsequent expression indices by 1 and
 * causing crashes. Replacing `</${X}>` with `</>` in source removes the
 * extra expression slot before Bun bundles.
 *
 * This is safe because solid-js/html's parser ignores closing tag names —
 * it only uses level-decrement, never matching open/close tag names.
 */
export function solidHtmlClosingTagPlugin(): Bun.BunPlugin {
  return {
    name: 'solid-html-closing-tag-fix',
    setup(build: Bun.PluginBuilder) {
      build.onLoad({ filter: /\.tsx?$/ }, async (args: Bun.OnLoadArgs) => {
        const filePath = toForwardSlash(args.path);
        const text = await Bun.file(filePath).text();
        if (!text.includes('</${')) return undefined; // fast skip
        return {
          contents: text.replace(/<\/\$\{([^}]+)\}>/g, '</>'),
          loader: filePath.endsWith('.tsx') ? 'tsx' : 'ts',
        };
      });
    },
  };
}

/**
 * Get the list of available bundled libraries.
 */
export function getAvailableBundledLibraries(): string[] {
  return Object.keys(BUNDLED_LIBRARIES).filter((k) => !k.includes('/'));
}

// Lazily cached .d.ts content
let _dtsContent: string | null = null;

function loadDtsContent(): string {
  if (_dtsContent == null) {
    // Always resolve from src/ — the .d.ts lives there, not in dist/
    const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const dtsPath = join(pkgRoot, 'src', 'bundled-types', 'index.d.ts');
    _dtsContent = readFileSync(dtsPath, 'utf-8');
  }
  return _dtsContent;
}

/**
 * Get detailed type information for a specific bundled library.
 * Extracts the `declare module '@bundled/...'` block(s) from the .d.ts file,
 * plus any preceding interface/type declarations that the module references.
 */
export function getBundledLibraryDetail(name: string): string | null {
  if (!(name in BUNDLED_LIBRARIES) && !name.includes('/')) return null;

  const content = loadDtsContent();

  // Collect all `declare module '@bundled/<name>...'` blocks
  const modulePattern = new RegExp(
    `^declare module '@bundled/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/[^']*)?'\\s*\\{`,
    'gm',
  );
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = modulePattern.exec(content)) !== null) {
    const start = match.index;
    let depth = 0;
    let end = start;
    for (let i = start; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    blocks.push(content.slice(start, end));
  }

  if (blocks.length === 0) return null;

  // For yaar/yaar-dev/yaar-web, also include the preceding interface declarations they reference
  const moduleText = blocks.join('\n\n');
  const referencedInterfaces = new Set<string>();
  const ifaceRefPattern = /:\s*(Yaar\w+)/g;
  let ifaceMatch: RegExpExecArray | null;
  while ((ifaceMatch = ifaceRefPattern.exec(moduleText)) !== null) {
    referencedInterfaces.add(ifaceMatch[1]);
  }

  const preambles: string[] = [];
  for (const ifaceName of referencedInterfaces) {
    const ifacePattern = new RegExp(`^interface ${ifaceName}[\\s<{]`, 'm');
    const ifaceStart = content.search(ifacePattern);
    if (ifaceStart === -1) continue;
    let depth = 0;
    let end = ifaceStart;
    for (let i = ifaceStart; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    preambles.push(content.slice(ifaceStart, end));
  }

  const parts = preambles.length > 0 ? [...preambles, '', ...blocks] : blocks;
  return parts.join('\n\n');
}
