/**
 * Nothing that ships inside the bundled exe may turn `import.meta.url` into a path.
 *
 * The binary is compiled with `--bytecode`, and that conversion bakes `import.meta.url`
 * and `import.meta.dir` to the **build machine's** source location instead of the
 * executable's virtual mount — the same behaviour `exe-assets.ts` probes its way around.
 * As a bare string that is a stale directory nobody reads. Put through `fileURLToPath` or
 * `createRequire` it is a crash, on Windows and only on Windows: the release workflow
 * cross-compiles every target on Linux, so the Windows binary carries
 * `file:///home/runner/...`, a path with no drive letter, which `fileURLToPath` refuses
 * with ERR_INVALID_FILE_URL_PATH. v0.20.2 shipped exactly that in `config/env.ts` and died
 * on its first import, before `main()` ran — a failure the Linux-only release smoke test
 * cannot feel, and no runtime test can either, since the suite never runs as the exe.
 *
 * So the rule is checked at the source level. Use `import.meta.dir`: it is already a path,
 * so a stale value stays a stale value instead of becoming an exception. Reading
 * `import.meta.url` for something that is not a path — the src-vs-dist `.ts` check in the
 * compiler's references worker — is untouched by this.
 */
import { describe, it, expect } from 'bun:test';
import { Glob } from 'bun';
import { join, sep } from 'path';

const PACKAGES_DIR = join(import.meta.dir, '..', '..', '..');

/** The packages Bun links into the executable. `frontend` rides along as assets, not code. */
const BUNDLED_PACKAGES = ['server', 'compiler', 'lib', 'shared'];

/** URL → path conversions. Each throws on Windows when handed a POSIX-rooted file URL. */
const FORBIDDEN = [
  /fileURLToPath\(\s*import\.meta\.url\s*\)/,
  /createRequire\(\s*import\.meta\.url\s*\)/,
  /new URL\([^)]*import\.meta\.url/,
];

/**
 * Code only — every file that explains this rule names the forbidden call while doing so,
 * including the one you are reading.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('bundled-exe module paths', () => {
  it('never converts import.meta.url to a path outside tests', async () => {
    const offenders: string[] = [];
    for (const pkg of BUNDLED_PACKAGES) {
      const src = join(PACKAGES_DIR, pkg, 'src');
      for await (const rel of new Glob('**/*.ts').scan({ cwd: src })) {
        const path = rel.replaceAll(sep, '/');
        if (path.endsWith('.test.ts') || path.includes('tests/')) continue;
        const code = stripComments(await Bun.file(join(src, rel)).text());
        if (FORBIDDEN.some((pattern) => pattern.test(code))) offenders.push(`${pkg}/src/${path}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
