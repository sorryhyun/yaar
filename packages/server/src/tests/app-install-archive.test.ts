/**
 * Packaging and unpacking a marketplace app archive — both ends of the same round trip.
 *
 * This used to assert on the *argv* of a `tar` spawn — that no absolute Windows path
 * reached it, because GNU tar reads the colon in `C:\…\app.tar.gz` as remote `host:path`
 * syntax and tries to connect to a host called C. `Bun.Archive` removed the spawn and that
 * whole class of bug with it, so the tests moved to what the replacement is actually
 * responsible for: stripping the leading component, and refusing an entry that would
 * escape the staging directory.
 */
import { describe, expect, it, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { extractAppArchive } from '../features/apps/archive.js';
import { packageAppTarball } from '../features/apps/publish.js';

const roots: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yaar-archive-test-'));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A gzipped tar shaped like the one `packageAppTarball` uploads. */
function tarball(entries: Record<string, string>): Promise<Uint8Array> {
  return new Bun.Archive(entries, { compress: 'gzip' }).bytes();
}

describe('marketplace app archive extraction', () => {
  it('strips the app-directory prefix every entry carries', async () => {
    const into = scratch();
    const result = await extractAppArchive(
      await tarball({
        'example-app/app.json': '{"id":"example-app"}',
        'example-app/src/main.ts': 'export const x = 1;\n',
        'example-app/src/ui/panel.ts': 'export const y = 2;\n',
      }),
      into,
    );

    expect(result.files).toBe(3);
    expect(await Bun.file(join(into, 'app.json')).text()).toBe('{"id":"example-app"}');
    expect(await Bun.file(join(into, 'src/main.ts')).text()).toBe('export const x = 1;\n');
    expect(await Bun.file(join(into, 'src/ui/panel.ts')).text()).toBe('export const y = 2;\n');
    // The prefix is gone rather than nested one level down.
    expect(await Bun.file(join(into, 'example-app/app.json')).exists()).toBe(false);
  });

  it('drops a top-level entry, which is what the stripped component is', async () => {
    const into = scratch();
    const result = await extractAppArchive(
      await tarball({ 'stray.txt': 'no prefix', 'example-app/app.json': '{}' }),
      into,
    );

    expect(result.files).toBe(1);
    expect(await Bun.file(join(into, 'stray.txt')).exists()).toBe(false);
    expect(await Bun.file(join(into, 'app.json')).exists()).toBe(true);
  });

  it('refuses an entry that would escape the staging directory', async () => {
    const into = scratch();
    await expect(
      extractAppArchive(
        await tarball({ 'example-app/app.json': '{}', 'example-app/../../pwned.txt': 'x' }),
        into,
      ),
    ).rejects.toThrow(/points outside the app directory/);
    expect(await Bun.file(join(into, '..', '..', 'pwned.txt')).exists()).toBe(false);
  });

  it('refuses an archive with nothing left after the strip', async () => {
    const into = scratch();
    await expect(extractAppArchive(await tarball({ 'lonely.txt': 'x' }), into)).rejects.toThrow(
      /no files/,
    );
  });
});

/**
 * Lay down an app directory from a `{ relative/path: contents }` map, creating the
 * intermediate directories. Returns the app dir, which is what `packageAppTarball` takes.
 */
function appDirWith(files: Record<string, string>): string {
  const appDir = join(scratch(), 'example-app');
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(appDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return appDir;
}

/** The entry names inside a packaged tarball, sorted. */
async function entryNames(tarball: Buffer): Promise<string[]> {
  const files = await new Bun.Archive(new Uint8Array(tarball)).files();
  return [...files.keys()].sort();
}

describe('marketplace app archive packaging', () => {
  it('prefixes every entry with the app directory name, at any depth', async () => {
    const appDir = appDirWith({
      'app.json': '{"id":"example-app"}',
      'src/main.ts': 'export const x = 1;\n',
      'src/ui/panel.ts': 'export const y = 2;\n',
      'agent/docs/usage.md': '# usage\n',
    });

    expect(await entryNames(await packageAppTarball('example-app', appDir))).toEqual([
      'example-app/agent/docs/usage.md',
      'example-app/app.json',
      'example-app/src/main.ts',
      'example-app/src/ui/panel.ts',
    ]);
  });

  it("excludes dist/, but only the app's own top-level one", async () => {
    const appDir = appDirWith({
      'app.json': '{}',
      'dist/index.html': '<html>build output</html>',
      // A nested `dist` is source as far as the marketplace is concerned — the exclude is
      // anchored at the app root, the way `tar --exclude example-app/dist` was.
      'src/vendor/dist/thing.ts': 'export const z = 3;\n',
    });

    expect(await entryNames(await packageAppTarball('example-app', appDir))).toEqual([
      'example-app/app.json',
      'example-app/src/vendor/dist/thing.ts',
    ]);
  });

  it('drops macOS cruft at any depth', async () => {
    const appDir = appDirWith({
      'app.json': '{}',
      '.DS_Store': 'finder',
      'src/.DS_Store': 'finder',
      'src/main.ts': 'export const x = 1;\n',
      'src/._main.ts': 'appledouble',
    });

    expect(await entryNames(await packageAppTarball('example-app', appDir))).toEqual([
      'example-app/app.json',
      'example-app/src/main.ts',
    ]);
  });

  it('skips a symlink rather than following it', async () => {
    const appDir = appDirWith({ 'app.json': '{}', 'src/main.ts': 'export const x = 1;\n' });
    symlinkSync('/etc/passwd', join(appDir, 'src', 'secrets.txt'));

    expect(await entryNames(await packageAppTarball('example-app', appDir))).toEqual([
      'example-app/app.json',
      'example-app/src/main.ts',
    ]);
  });

  it('refuses an app directory with nothing to publish', async () => {
    const appDir = join(scratch(), 'example-app');
    mkdirSync(join(appDir, 'dist'), { recursive: true });
    writeFileSync(join(appDir, 'dist', 'index.html'), 'only build output');

    await expect(packageAppTarball('example-app', appDir)).rejects.toThrow(/no files to publish/);
  });

  it('round-trips: what packaging produces is what extraction takes apart', async () => {
    const appDir = appDirWith({
      'app.json': '{"id":"example-app"}',
      'src/main.ts': 'export const x = 1;\n',
      'src/ui/panel.ts': 'export const y = 2;\n',
      'dist/index.html': '<html>build output</html>',
    });

    const into = scratch();
    const result = await extractAppArchive(
      new Uint8Array(await packageAppTarball('example-app', appDir)),
      into,
    );

    // The prefix packaging added is exactly the component extraction strips.
    expect(result.files).toBe(3);
    expect(await Bun.file(join(into, 'app.json')).text()).toBe('{"id":"example-app"}');
    expect(await Bun.file(join(into, 'src/ui/panel.ts')).text()).toBe('export const y = 2;\n');
    expect(await Bun.file(join(into, 'dist/index.html')).exists()).toBe(false);
  });
});
