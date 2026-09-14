/**
 * zip, tar and tar.gz: what the readers return, and — the point of most rows — what they refuse.
 *
 * The refusals are the reason this module exists instead of a dependency: an entry whose header
 * lies about its size, a gzip that inflates past its cap or hides a second gzip, a name that climbs
 * out of the destination. Each of those used to be a success somewhere (a truncated entry, an
 * unbounded inflate, a quietly renamed file), so each gets a row that fails if it becomes one again.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  ArchiveError,
  archiveFormatOf,
  buildTar,
  openArchive,
  safeEntryPath,
  writeZip,
  type ArchiveLimits,
  type ZipInputFile,
  type ZipWriteOptions,
} from '../archive/index.js';

const LIMITS: ArchiveLimits = {
  maxEntryBytes: 16 * 1024 * 1024,
  maxEntries: 1000,
  maxTarBytes: 16 * 1024 * 1024,
};

/**
 * Made by Info-ZIP's `zip` 3.0, not by this module: a directory entry, two stored files and one
 * deflated file, all stamped 2021-03-04 05:06. The interop row — the writer's own round trip can
 * only prove the two halves agree with each other.
 */
const CLI_ZIP_BASE64 =
  'UEsDBAoAAAAAAMAoZFIAAAAAAAAAAAAAAAAJAAAAcGtnL2RvY3MvUEsDBAoAAAAAAMAoZFK01KUTFwAAABcAAAATAAAAcGtnL2RvY3MvcmVhZG1lLnR4dGhlbGxvIGZyb20gdGhlIHppcCBDTEkKUEsDBBQAAAAIAMAoZFIggVHaBwAAAE0AAAAPAAAAcGtnL3NxdWVlemUudHh0S0ykHuACAFBLAwQKAAAAAADAKGRSgxbcjAEAAAABAAAADAAAAHBrZy90aW55LmJpbnhQSwECHgMKAAAAAADAKGRSAAAAAAAAAAAAAAAACQAAAAAAAAAAABAA7UEAAAAAcGtnL2RvY3MvUEsBAh4DCgAAAAAAwChkUrTUpRMXAAAAFwAAABMAAAAAAAAAAQAAAKSBJwAAAHBrZy9kb2NzL3JlYWRtZS50eHRQSwECHgMUAAAACADAKGRSIIFR2gcAAABNAAAADwAAAAAAAAABAAAApIFvAAAAcGtnL3NxdWVlemUudHh0UEsBAh4DCgAAAAAAwChkUoMW3IwBAAAAAQAAAAwAAAAAAAAAAAAAAKSBowAAAHBrZy90aW55LmJpblBLBQYAAAAABAAEAO8AAADOAAAAAAA=';

let dir: string;
let counter = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yaar-archive-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A file in the scratch dir, named uniquely so rows never share one. */
async function scratchFile(content: string | Uint8Array, suffix = '.bin'): Promise<string> {
  const path = join(dir, `f${counter++}${suffix}`);
  await Bun.write(path, content);
  return path;
}

async function zipOf(
  files: Array<{ name: string; content: string | Uint8Array }>,
  options?: ZipWriteOptions,
): Promise<string> {
  const inputs: ZipInputFile[] = [];
  for (const f of files) inputs.push({ name: f.name, absolutePath: await scratchFile(f.content) });
  const chunks: Uint8Array[] = [];
  await writeZip(inputs, async (chunk) => void chunks.push(chunk.slice()), options);
  return scratchFile(Buffer.concat(chunks), '.zip');
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Offset of the last occurrence of a little-endian u32 signature. */
function lastSignature(bytes: Uint8Array, signature: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = bytes.length - 4; i >= 0; i--) if (view.getUint32(i, true) === signature) return i;
  throw new Error('signature not found');
}

describe('archiveFormatOf', () => {
  it('reads the format off the extension, case-insensitively', () => {
    expect(archiveFormatOf('a/b.zip')).toBe('zip');
    expect(archiveFormatOf('B.ZIP')).toBe('zip');
    expect(archiveFormatOf('x.tar')).toBe('tar');
    expect(archiveFormatOf('x.tar.gz')).toBe('tar.gz');
    expect(archiveFormatOf('x.tgz')).toBe('tar.gz');
    expect(archiveFormatOf('x.gz')).toBeNull();
    expect(archiveFormatOf('x.7z')).toBeNull();
  });
});

describe('safeEntryPath', () => {
  it('normalizes a name that stays inside', () => {
    expect(safeEntryPath('a/b.txt')).toBe('a/b.txt');
    expect(safeEntryPath('./a//b.txt')).toBe('a/b.txt');
    expect(safeEntryPath('a\\b.txt')).toBe('a/b.txt');
    expect(safeEntryPath('dir/')).toBe('dir');
  });

  it('refuses a name that climbs out, is absolute, or names nothing', () => {
    expect(safeEntryPath('../x')).toBeNull();
    expect(safeEntryPath('a/../../x')).toBeNull();
    // Refused even when it would resolve inside: the archive did not call it `b`.
    expect(safeEntryPath('a/../b')).toBeNull();
    expect(safeEntryPath('/etc/passwd')).toBeNull();
    expect(safeEntryPath('C:/Windows/x')).toBeNull();
    expect(safeEntryPath('./')).toBeNull();
  });
});

describe('zip written by another tool', () => {
  it('lists and reads stored and deflated entries', async () => {
    const path = await scratchFile(Buffer.from(CLI_ZIP_BASE64, 'base64'), '.zip');
    const reader = await openArchive(path, 'zip', LIMITS);

    expect(reader.entries.map((e) => [e.path, e.isDirectory, e.size])).toEqual([
      ['pkg/docs', true, 0],
      ['pkg/docs/readme.txt', false, 23],
      ['pkg/squeeze.txt', false, 77],
      ['pkg/tiny.bin', false, 1],
    ]);
    expect(reader.entries[1].modifiedAt?.getFullYear()).toBe(2021);
    expect(text(await reader.read('pkg/docs/readme.txt'))).toBe('hello from the zip CLI\n');
    expect(text(await reader.read('pkg/squeeze.txt'))).toBe(`${'a'.repeat(76)}\n`);
    expect(text(await reader.read('pkg/tiny.bin'))).toBe('x');
  });
});

describe('writeZip → openArchive', () => {
  const random = crypto.getRandomValues(new Uint8Array(70_000));

  it('round-trips deflated, stored and non-ASCII entries', async () => {
    const path = await zipOf(
      [
        { name: 'notes/한글.txt', content: 'hello '.repeat(500) },
        { name: 'noise.bin', content: random },
        { name: 'photo.png', content: 'pretend these bytes are compressed' },
      ],
      { storeExtensions: new Set(['.png']) },
    );
    const reader = await openArchive(path, 'zip', LIMITS);
    expect(reader.entries.map((e) => e.path)).toEqual(['notes/한글.txt', 'noise.bin', 'photo.png']);
    expect(text(await reader.read('notes/한글.txt'))).toBe('hello '.repeat(500));
    expect(await reader.read('noise.bin')).toEqual(random);
    expect(text(await reader.read('photo.png'))).toBe('pretend these bytes are compressed');
  });

  it('round-trips through ZIP64 records', async () => {
    const path = await zipOf(
      [
        { name: 'a.txt', content: 'alpha '.repeat(100) },
        { name: 'b.bin', content: random },
      ],
      { forceZip64: true },
    );
    const reader = await openArchive(path, 'zip', LIMITS);
    expect(reader.entries.map((e) => [e.path, e.size])).toEqual([
      ['a.txt', 600],
      ['b.bin', random.length],
    ]);
    expect(text(await reader.read('a.txt'))).toBe('alpha '.repeat(100));
    expect(await reader.read('b.bin')).toEqual(random);
  });

  it('round-trips a file too large to deflate, which is streamed and stored', async () => {
    const path = await zipOf([{ name: 'big.bin', content: random }], { deflateMaxBytes: 1024 });
    const reader = await openArchive(path, 'zip', LIMITS);
    expect(await reader.read('big.bin')).toEqual(random);
  });

  it('refuses entry names that climb out, and reports them', async () => {
    const path = await zipOf([
      { name: '../evil.txt', content: 'x' },
      { name: 'ok.txt', content: 'fine' },
    ]);
    const reader = await openArchive(path, 'zip', LIMITS);
    expect(reader.entries.map((e) => e.path)).toEqual(['ok.txt']);
    expect(reader.rejected).toEqual(['../evil.txt']);
  });
});

describe('zip reads that must fail', () => {
  it('refuses an entry that inflates past the size its header declares', async () => {
    const path = await zipOf([{ name: 'z.bin', content: new Uint8Array(200_000) }]);
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    // Under-state the uncompressed size in the central directory: 200 000 → 1 000.
    const central = lastSignature(bytes, 0x02014b50);
    new DataView(bytes.buffer).setUint32(central + 24, 1000, true);
    const lying = await scratchFile(bytes, '.zip');

    const reader = await openArchive(lying, 'zip', LIMITS);
    await expect(reader.read('z.bin')).rejects.toThrow(/inflates past its declared 1000 bytes/);
  });

  it('refuses an entry whose bytes fail the CRC', async () => {
    const path = await zipOf([{ name: 's.png', content: 'stored, so a flipped byte survives' }], {
      storeExtensions: new Set(['.png']),
    });
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    // Local header (30) + name (5) is where the stored bytes start.
    bytes[30 + 's.png'.length] ^= 0xff;
    const corrupt = await scratchFile(bytes, '.zip');

    const reader = await openArchive(corrupt, 'zip', LIMITS);
    await expect(reader.read('s.png')).rejects.toThrow(/CRC-32/);
  });

  it('lists an entry above maxEntryBytes but refuses to inflate it', async () => {
    const path = await zipOf([{ name: 'big.txt', content: 'y'.repeat(5000) }]);
    const reader = await openArchive(path, 'zip', { ...LIMITS, maxEntryBytes: 1000 });
    expect(reader.entries.map((e) => e.size)).toEqual([5000]);
    await expect(reader.read('big.txt')).rejects.toThrow(ArchiveError);
  });

  it('refuses an archive with more entries than allowed', async () => {
    const path = await zipOf([
      { name: 'a', content: '1' },
      { name: 'b', content: '2' },
      { name: 'c', content: '3' },
    ]);
    await expect(openArchive(path, 'zip', { ...LIMITS, maxEntries: 2 })).rejects.toThrow(
      /3 entries/,
    );
  });

  it('refuses a file that is not a zip', async () => {
    const path = await scratchFile('definitely not a zip', '.zip');
    await expect(openArchive(path, 'zip', LIMITS)).rejects.toThrow(ArchiveError);
  });
});

describe('tar and tar.gz', () => {
  it('round-trips through buildTar, plain and gzipped', async () => {
    const inputs = [
      { name: 'docs/readme.md', absolutePath: await scratchFile('# hi') },
      { name: 'data.json', absolutePath: await scratchFile('{"a":1}') },
    ];
    for (const gzip of [false, true]) {
      const bytes = await buildTar(inputs, { gzip, maxBytes: LIMITS.maxTarBytes });
      const path = await scratchFile(bytes, gzip ? '.tar.gz' : '.tar');
      const reader = await openArchive(path, gzip ? 'tar.gz' : 'tar', LIMITS);
      expect(reader.entries.map((e) => e.path).sort()).toEqual(['data.json', 'docs/readme.md']);
      expect(text(await reader.read('docs/readme.md'))).toBe('# hi');
    }
  });

  it('reads a gzipped tar named .tar, since the bytes are sniffed', async () => {
    const bytes = await buildTar([{ name: 'x.txt', absolutePath: await scratchFile('x') }], {
      gzip: true,
      maxBytes: LIMITS.maxTarBytes,
    });
    const reader = await openArchive(await scratchFile(bytes, '.tar'), 'tar', LIMITS);
    expect(text(await reader.read('x.txt'))).toBe('x');
  });

  it('refuses a tar.gz that inflates past maxTarBytes', async () => {
    const bytes = await buildTar(
      [{ name: 'zeros.bin', absolutePath: await scratchFile(new Uint8Array(4_000_000)) }],
      { gzip: true, maxBytes: LIMITS.maxTarBytes },
    );
    const path = await scratchFile(bytes, '.tar.gz');
    await expect(
      openArchive(path, 'tar.gz', { ...LIMITS, maxTarBytes: 1_000_000 }),
    ).rejects.toThrow(/inflates past 1000000 bytes/);
  });

  it('refuses gzip inside gzip, which Bun.Archive would inflate without a cap', async () => {
    const inner = await buildTar([{ name: 'x.txt', absolutePath: await scratchFile('x') }], {
      gzip: true,
      maxBytes: LIMITS.maxTarBytes,
    });
    const path = await scratchFile(gzipSync(inner), '.tar.gz');
    await expect(openArchive(path, 'tar.gz', LIMITS)).rejects.toThrow(/gzip inside gzip/);
  });

  it('refuses entry names that climb out, and reports them', async () => {
    const bytes = await new Bun.Archive({ '../up.txt': 'u', 'ok.txt': 'k' }).bytes();
    const reader = await openArchive(await scratchFile(bytes, '.tar'), 'tar', LIMITS);
    expect(reader.entries.map((e) => e.path)).toEqual(['ok.txt']);
    expect(reader.rejected).toEqual(['../up.txt']);
  });

  it('refuses to build a tar from more than maxBytes of input', async () => {
    const inputs = [{ name: 'a.bin', absolutePath: await scratchFile(new Uint8Array(2000)) }];
    await expect(buildTar(inputs, { gzip: false, maxBytes: 1000 })).rejects.toThrow(/use \.zip/);
  });
});
