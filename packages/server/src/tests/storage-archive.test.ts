/**
 * Archives as storage sees them: a read-only folder you can list and read into, and the two
 * operations that make and unmake one.
 *
 * The read side rides on `storageRead` / `storageList` rather than a new verb shape, so these rows
 * assert at that layer — every door (both verb handlers, the app agent's `storage:*` built-ins)
 * inherits exactly what is pinned here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { storageCompress, storageExtract } from '../storage/archive-ops.js';
import {
  resolvePath,
  storageDelete,
  storageList,
  storageRead,
  storageWrite,
} from '../storage/storage-manager.js';

// Under `temp/`, the documented scratch prefix — see storage-bytes.test.ts for why not a
// per-test root.
const SCRATCH = `temp/__storage-archive-test-${process.pid}`;

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  await storageWrite(`${SCRATCH}/src/docs/readme.md`, '# hello');
  await storageWrite(`${SCRATCH}/src/data.json`, '{"a":1}');
  await storageWrite(`${SCRATCH}/src/pixel.png`, PNG_BYTES);
});

afterAll(async () => {
  await storageDelete(SCRATCH);
});

const names = (entries: Array<{ path: string }> | undefined, base: string) =>
  (entries ?? []).map((e) => e.path.slice(base.length + 1));

describe('a zip made by compress', () => {
  const zip = `${SCRATCH}/out.zip`;

  beforeAll(async () => {
    const result = await storageCompress([`${SCRATCH}/src`], zip);
    expect(result).toMatchObject({ success: true, format: 'zip', files: 3 });
  });

  it('lists as a folder, folders first, one level at a time', async () => {
    const root = await storageList(zip);
    expect(root.success).toBe(true);
    expect(names(root.entries, zip)).toEqual(['src']);
    expect(root.entries?.[0].isDirectory).toBe(true);

    const inner = await storageList(`${zip}/src`);
    expect(names(inner.entries, `${zip}/src`)).toEqual(['docs', 'data.json', 'pixel.png']);
  });

  it('reads an entry as the file it holds', async () => {
    expect(await storageRead(`${zip}/src/docs/readme.md`)).toMatchObject({
      success: true,
      content: '# hello',
    });
    const image = await storageRead(`${zip}/src/pixel.png`, { rawImage: true });
    expect(image.images?.[0].data).toBe(PNG_BYTES.toString('base64'));
  });

  it('answers a read of the archive itself the way a directory does', async () => {
    expect(await storageRead(zip)).toMatchObject({
      success: false,
      isDirectory: true,
      isArchive: true,
    });
    expect(await storageRead(`${zip}/src/docs`)).toMatchObject({ isDirectory: true });
  });

  it('tells a missing entry apart from a file listed as a folder', async () => {
    expect(await storageRead(`${zip}/src/nope.txt`)).toMatchObject({
      success: false,
      notFound: true,
    });
    expect(await storageList(`${zip}/nope`)).toMatchObject({ success: false, notFound: true });
    const fileAsFolder = await storageList(`${zip}/src/data.json`);
    expect(fileAsFolder.error).toContain('is a file');
  });

  it('extracts into a new folder, byte for byte', async () => {
    const dest = `${SCRATCH}/unpacked`;
    expect(await storageExtract(zip, dest)).toMatchObject({ success: true, files: 3 });
    const png = await Bun.file(resolvePath(`${dest}/src/pixel.png`)!.absolutePath).bytes();
    expect(Buffer.from(png).equals(PNG_BYTES)).toBe(true);
    expect(await storageRead(`${dest}/src/docs/readme.md`)).toMatchObject({ content: '# hello' });
  });

  it('refuses to extract over a folder that already holds something', async () => {
    const result = await storageExtract(zip, `${SCRATCH}/src`);
    expect(result.success).toBe(false);
    expect(await storageRead(`${SCRATCH}/src/data.json`)).toMatchObject({ content: '{"a":1}' });
  });
});

describe('compress', () => {
  it('builds a tar.gz whose sources land under their own names', async () => {
    const tgz = `${SCRATCH}/mixed.tar.gz`;
    const result = await storageCompress([`${SCRATCH}/src/docs`, `${SCRATCH}/src/data.json`], tgz);
    expect(result).toMatchObject({ success: true, format: 'tar.gz', files: 2 });
    expect(names((await storageList(tgz)).entries, tgz)).toEqual(['docs', 'data.json']);
    expect(await storageRead(`${tgz}/docs/readme.md`)).toMatchObject({ content: '# hello' });
  });

  it('refuses two sources that would put the same name in the archive', async () => {
    const result = await storageCompress(
      [`${SCRATCH}/src/data.json`, `${SCRATCH}/src/data.json`],
      `${SCRATCH}/dup.zip`,
    );
    expect(result).toMatchObject({ success: false });
  });

  it('refuses a destination with no archive extension', async () => {
    const result = await storageCompress([`${SCRATCH}/src`], `${SCRATCH}/out.rar`);
    expect(result).toMatchObject({ success: false });
  });

  it('never packs the archive it is writing into itself', async () => {
    const self = `${SCRATCH}/src/self.zip`;
    await storageCompress([`${SCRATCH}/src`], self);
    await storageCompress([`${SCRATCH}/src`], self);
    const listed = await storageList(`${self}/src`);
    expect(names(listed.entries, `${self}/src`)).not.toContain('self.zip');
    await storageDelete(self);
  });
});

describe('extract', () => {
  it('writes nothing for an entry name that climbs out, and reports it', async () => {
    const tar = `${SCRATCH}/hostile.tar`;
    await storageWrite(
      tar,
      Buffer.from(await new Bun.Archive({ '../escape.txt': 'x', 'ok.txt': 'fine' }).bytes()),
    );
    const result = await storageExtract(tar, `${SCRATCH}/hostile`);
    expect(result).toMatchObject({ success: true, files: 1, rejected: ['../escape.txt'] });
    expect(await storageRead(`${SCRATCH}/escape.txt`)).toMatchObject({ notFound: true });
    expect(await storageRead(`${SCRATCH}/hostile/ok.txt`)).toMatchObject({ content: 'fine' });
  });
});
