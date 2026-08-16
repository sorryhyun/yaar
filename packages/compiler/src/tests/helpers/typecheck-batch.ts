/**
 * Type-checking many fixtures with one `tsc`, for the two suites that assert on
 * diagnostics.
 *
 * Both of them pin type-level machinery that has no runtime behaviour to test —
 * `defineAppCommand`'s and `defineApp`'s derivation of `run`'s parameter from a `params`
 * schema — so running the real compiler *is* the test and a cheaper substitute would not
 * test the thing. What was not the point was booting the compiler once per assertion.
 *
 * Measured on these fixtures: a `tsc` launch costs ~2.2s before it looks at the source —
 * ~1.5s of that is loading `bundled-types/index.d.ts` and the type surface its re-exports
 * reach — while a fixture itself costs ~100-250ms. Eighteen launches across the two files
 * was ~40s of a ~66s package suite, and the compiler package sets the whole monorepo's
 * wall clock. Each file's fixtures in one program is ~2.5s, because the startup is paid
 * once. (`skipLibCheck` was already on and does not help: it skips *checking* `.d.ts`
 * files, not parsing them. Running the launches concurrently only halves it — they
 * contend for CPU and each still boots.)
 *
 * The cost is an ordering rule, and it is enforced rather than documented: fixtures must
 * be registered while the file is being collected, not from inside a test body, because
 * the batch runs in `beforeAll`. Registering later throws instead of quietly
 * type-checking nothing.
 *
 * Each fixture is its own module in one program, so they cannot interfere — none imports
 * another, and tsc reports diagnostics per file. The options mirror `typecheckSandbox`
 * (notably `strict: false`) so a fixture that passes here passes for a real app, and
 * `tsc` is driven through Bun rather than its node-shebang bin script, so the suite does
 * not require a node install.
 *
 * This lives here rather than in either suite because the two had byte-identical copies
 * of the per-call version, tsconfig literal included — which is one edit away from two
 * suites disagreeing about what "a real app's compiler options" means.
 */

import { mkdtemp, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const BUNDLED_TYPES = resolve(import.meta.dir, '../../bundled-types');
const TSC_JS = resolve(import.meta.dir, '../../../node_modules/typescript/lib/tsc.js');

/** A fixture name has to survive being a filename and a prefix match on tsc's output. */
const FIXTURE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** `src/name.ts(6,21): error TS2551: …` — the line that starts a diagnostic. */
const DIAGNOSTIC_START = /^src\/([a-z0-9-]+)\.ts\(\d+,\d+\):/;

export interface TypecheckBatch {
  /**
   * Register a source to type-check, and get back its diagnostics — later.
   *
   * The indirection is the batching: nothing runs at call time, and the returned accessor
   * only works once {@link TypecheckBatch.run} has compiled every registered fixture
   * together. Diagnostics come back as trimmed non-empty lines, tsc's continuation lines
   * included, in the order tsc emitted them.
   */
  fixture(name: string, source: string): () => string[];
  /** Compile every registered fixture in one program. Call from `beforeAll`. */
  run(): Promise<void>;
  /** Remove the sandbox. Call from `afterAll`. */
  cleanup(): Promise<void>;
}

/**
 * One batch per test file. `label` names the temp directory, so a leaked sandbox says
 * which suite leaked it.
 */
export function createTypecheckBatch(label: string): TypecheckBatch {
  const sources = new Map<string, string>();
  const diagnostics = new Map<string, string[]>();
  let sandbox: string | null = null;
  let ran = false;

  function fixture(name: string, source: string): () => string[] {
    if (ran) {
      throw new Error(
        `fixture("${name}") was registered after the batch ran — call it while the file ` +
          'is being collected (module or describe scope), not inside a test body.',
      );
    }
    if (!FIXTURE_NAME.test(name)) throw new Error(`fixture name must be kebab-case: "${name}"`);
    if (sources.has(name)) throw new Error(`duplicate fixture name: "${name}"`);
    sources.set(name, source);

    return () => {
      const found = diagnostics.get(name);
      if (!found) throw new Error(`no diagnostics recorded for fixture "${name}"`);
      return found;
    };
  }

  /**
   * Split one run's output back into per-fixture diagnostics.
   *
   * tsc indents a diagnostic's continuation lines and gives them no file prefix, so a
   * line that starts no diagnostic belongs to whichever one preceded it. A line that
   * belongs to nothing — a config error, a diagnostic for an unregistered file — is
   * returned, not dropped: swallowing it would turn a broken tsconfig into a file full of
   * green tests.
   */
  function attribute(output: string): string[] {
    const unattributed: string[] = [];
    let current: string[] | null = null;

    for (const raw of output.split('\n')) {
      const line = raw.trim();
      if (!line) continue;

      const start = DIAGNOSTIC_START.exec(line);
      if (start) {
        current = diagnostics.get(start[1]) ?? null;
        if (current) current.push(line);
        else unattributed.push(line);
        continue;
      }
      if (current) current.push(line);
      else unattributed.push(line);
    }
    return unattributed;
  }

  async function run(): Promise<void> {
    sandbox = await mkdtemp(join(tmpdir(), `yaar-${label}-`));
    await mkdir(join(sandbox, 'src'), { recursive: true });

    const files: string[] = [];
    for (const [name, source] of sources) {
      const rel = `src/${name}.ts`;
      await Bun.write(join(sandbox, rel), source);
      files.push(rel);
      diagnostics.set(name, []);
    }

    const tsconfigPath = join(sandbox, 'tsconfig.json');
    await Bun.write(
      tsconfigPath,
      JSON.stringify({
        compilerOptions: {
          strict: false,
          noEmit: true,
          target: 'ES2022',
          module: 'ES2022',
          moduleResolution: 'bundler',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          types: [],
          paths: { '@bundled/*': [join(BUNDLED_TYPES, '*')] },
          skipLibCheck: true,
        },
        // `files`, not `include`: the program is exactly what was registered, so a stray
        // file left in the sandbox cannot join it and report diagnostics for no test.
        files: [join(BUNDLED_TYPES, 'index.d.ts'), ...files],
      }),
    );

    const proc = Bun.spawn([process.execPath, TSC_JS, '--noEmit', '-p', tsconfigPath], {
      cwd: sandbox,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    ran = true;

    const unattributed = attribute(stdout);
    if (unattributed.length > 0 || stderr.trim()) {
      throw new Error(
        'tsc reported output belonging to no fixture — the sandbox or tsconfig is wrong, ' +
          `not the fixtures:\n${[...unattributed, stderr.trim()].filter(Boolean).join('\n')}`,
      );
    }
  }

  async function cleanup(): Promise<void> {
    if (sandbox) await rm(sandbox, { recursive: true, force: true });
  }

  return { fixture, run, cleanup };
}
