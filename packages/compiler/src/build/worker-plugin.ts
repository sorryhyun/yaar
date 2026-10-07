/**
 * `import MatchWorker from './match.worker.ts?worker'` — a Web Worker that ships
 * inside the single HTML file.
 *
 * An app is one self-contained document, so a worker cannot be a sibling `.js`
 * the page fetches. Before this, apps built the worker by hand: stringify a few
 * functions (`[runRegex, …].map(String)`, `apps/lab`'s `KERNEL_SRC`) and hand
 * the text to a Blob. That breaks the moment a stringified function calls a
 * helper it does not carry, or the minifier renames something the string
 * refers to — a ReferenceError inside the worker, at runtime, with a green build.
 *
 * Here the worker file is an ordinary module: it is bundled on its own, through
 * the same plugins as the app, and the result is inlined into the importing
 * module as a string. The default export starts one worker per call from a
 * Blob URL made once per module.
 *
 * Two passes, because Bun deadlocks when a plugin awaits a nested `Bun.build`
 * from inside `onLoad`. The plugin only records each worker and emits a module
 * whose source string is a placeholder token; once the outer build is done,
 * `inlineWorkers` builds every recorded worker and splices its code in over the
 * token.
 *
 * The YAAR SDK is refused inside a worker build: it lives on `window` (the SDK
 * scripts the HTML wrapper injects), which a worker does not have. A worker that
 * needs the SDK posts a message to the page and lets the page call it.
 */

import { dirname } from 'path';
import { toForwardSlash } from '../bundled/registry.js';

/** The suffix that turns a module import into a worker import. */
export const WORKER_QUERY = '?worker';

const NAMESPACE = 'yaar-worker';

/** Worker entry path → the placeholder token its importer carries. */
export type WorkerTable = Map<string, string>;

/** Bundles a worker entry; the caller supplies the app's own build, so both resolve alike. */
export type BuildWorker = (entryPoint: string) => Promise<Bun.BuildOutput>;

/**
 * The module an `?worker` import resolves to: the bundled worker source as a
 * string, and a factory that works with or without `new`.
 *
 * `type: 'module'` because the worker bundle is ESM — a worker file may `export`
 * (a helper its tests import), and a classic worker would reject the syntax. The
 * Blob URL is never revoked: the factory may run again, and a worker created from
 * a revoked URL fails to load.
 */
export function workerModuleSource(sourceLiteral: string): string {
  return [
    `const source = ${sourceLiteral};`,
    'let url;',
    'export default function WorkerFactory(options) {',
    "  url ??= URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));",
    "  return new Worker(url, { ...options, type: 'module' });",
    '}',
  ].join('\n');
}

export function workerImportPlugin(workers: WorkerTable): Bun.BunPlugin {
  return {
    name: 'yaar-worker-import',
    setup(build: Bun.PluginBuilder) {
      build.onResolve({ filter: /\?worker$/ }, (args: Bun.OnResolveArgs) => {
        const specifier = args.path.slice(0, -WORKER_QUERY.length);
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
          throw new Error(
            `"${args.path}": a ?worker import must be a relative path to a file in the app.`,
          );
        }
        const path = toForwardSlash(Bun.resolveSync(specifier, dirname(args.importer)));
        return { path, namespace: NAMESPACE };
      });

      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args: Bun.OnLoadArgs) => {
        let token = workers.get(args.path);
        if (!token) {
          token = `__YAAR_WORKER_SOURCE_${workers.size}_${crypto.randomUUID().replace(/-/g, '')}__`;
          workers.set(args.path, token);
        }
        return { contents: workerModuleSource(JSON.stringify(token)), loader: 'js' };
      });
    },
  };
}

/** A build result carrying only an error, in the shape `formatBuildLogs` reads. */
export function failedBuild(message: string): Bun.BuildOutput {
  return {
    success: false,
    outputs: [],
    logs: [{ level: 'error', message, position: null, name: 'BuildMessage' }],
  } as unknown as Bun.BuildOutput;
}

/** Replace the quoted placeholder (any quote style the minifier chose) with the code. */
function splice(code: string, token: string, workerCode: string): string {
  const literal = new RegExp(`(["'\`])${token}\\1`, 'g');
  return code.replace(literal, () => JSON.stringify(workerCode));
}

/**
 * Second pass: build each worker the first pass recorded, and splice its code into
 * the entry chunk. A worker that fails to build fails the whole build, naming the
 * worker; one that emits a sibling file is refused for the same reason the app is.
 */
export async function inlineWorkers(
  result: Bun.BuildOutput,
  workers: WorkerTable,
  buildWorker: BuildWorker,
): Promise<Bun.BuildOutput> {
  if (!result.success || workers.size === 0) return result;

  const built = new Map<string, string>();
  for (const [entry, token] of workers) {
    const worker = await buildWorker(entry);
    if (!worker.success) {
      const lines = worker.logs
        .filter((log) => log.level === 'error')
        .map((log) => {
          const message = log.message || String(log);
          const pos = log.position;
          return pos ? `${pos.file || entry}:${pos.line}:${pos.column}: ${message}` : message;
        });
      return failedBuild(
        `Worker ${entry} failed to bundle:\n${lines.join('\n') || 'no output produced'}`,
      );
    }
    const siblings = worker.outputs.filter((output) => output.kind === 'asset');
    if (siblings.length > 0) {
      return failedBuild(
        `Worker ${entry} emitted sibling files a single-file app cannot serve: ` +
          siblings.map((asset) => asset.path).join(', '),
      );
    }
    const chunk = worker.outputs.find((output) => output.kind === 'entry-point');
    if (!chunk) return failedBuild(`Worker ${entry} produced no output`);
    built.set(token, await chunk.text());
  }

  const outputs = await Promise.all(
    result.outputs.map(async (output) => {
      if (output.kind !== 'entry-point') return output;
      let code = await output.text();
      for (const [token, workerCode] of built) code = splice(code, token, workerCode);
      // Callers read `kind`, `path` and `text()`. A plain object: BuildArtifact's
      // getters refuse to run on anything but a real instance.
      return {
        kind: output.kind,
        path: output.path,
        loader: output.loader,
        text: async () => code,
      };
    }),
  );
  return { ...result, outputs } as unknown as Bun.BuildOutput;
}
