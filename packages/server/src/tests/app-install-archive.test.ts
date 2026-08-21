/**
 * Unpacking a marketplace app archive.
 *
 * This used to assert on the *argv* of a `tar` spawn — that no absolute Windows path
 * reached it, because GNU tar reads the colon in `C:\…\app.tar.gz` as remote `host:path`
 * syntax and tries to connect to a host called C. `Bun.Archive` removed the spawn and that
 * whole class of bug with it, so the tests moved to what the replacement is actually
 * responsible for: stripping the leading component, and refusing an entry that would
 * escape the staging directory.
 */
import { describe, expect, it, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractAppArchive } from '../features/apps/archive.js';

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
