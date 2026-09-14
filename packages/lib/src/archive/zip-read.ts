/**
 * A zip reader that takes names from the central directory and trusts nothing about sizes.
 *
 * Written against `node:zlib` rather than taken from a library, for two properties no candidate
 * offered together:
 *
 * - **Every read is checked.** The declared size and CRC-32 are compared with what the inflate
 *   actually produced. fflate's `unzipSync` sizes its output buffer from the header and exposes
 *   no CRC, so an entry whose header under-states its size comes back truncated, as a success.
 * - **An inflate cannot outgrow its declaration.** `inflateRawSync`'s `maxOutputLength` stops at
 *   the declared size, so a header that lies low fails instead of allocating whatever the stream
 *   really expands to — which is the whole mechanism of a zip bomb. A header that lies *high* is
 *   caught earlier, by `maxEntryBytes`, before anything is allocated.
 *
 * The file is read by range (`Bun.file().slice()`): listing a multi-gigabyte archive costs its
 * central directory, and reading one entry costs that entry.
 */

import { inflateRawSync } from 'node:zlib';
import {
  ArchiveError,
  safeEntryPath,
  type ArchiveEntry,
  type ArchiveLimits,
  type ArchiveReader,
} from './types.js';
import {
  CENTRAL_HEADER_SIZE,
  EOCD64_LOCATOR_SIZE,
  EOCD64_SIZE,
  EOCD_SIZE,
  EXTRA_ZIP64,
  FLAG_ENCRYPTED,
  HOST_UNIX,
  LOCAL_HEADER_SIZE,
  MAX_U16,
  MAX_U32,
  METHOD_DEFLATE,
  METHOD_STORE,
  S_IFLNK,
  S_IFMT,
  SIG_CENTRAL,
  SIG_EOCD,
  SIG_EOCD64,
  SIG_EOCD64_LOCATOR,
  SIG_LOCAL,
} from './zip-format.js';

/** A central directory claiming more than this is refused before it is read into memory. */
const MAX_CENTRAL_DIRECTORY_BYTES = 256 * 1024 * 1024;

interface ZipRecord {
  entry: ArchiveEntry;
  method: number;
  crc: number;
  compressedSize: number;
  localOffset: number;
}

const utf8 = new TextDecoder();

const viewOf = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function u64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArchiveError('zip: a 64-bit size or offset is out of range');
  }
  return Number(value);
}

function dosDate(date: number, time: number): Date | undefined {
  if (date === 0) return undefined;
  return new Date(
    ((date >> 9) & 0x7f) + 1980,
    ((date >> 5) & 0xf) - 1,
    date & 0x1f,
    time >> 11,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  );
}

export async function openZip(
  filePath: string,
  limits: ArchiveLimits,
): Promise<Omit<ArchiveReader, 'format'>> {
  const file = Bun.file(filePath);
  const fileSize = file.size;
  const range = async (start: number, end: number): Promise<Uint8Array> => {
    if (start < 0 || end > fileSize || start > end) {
      throw new ArchiveError('zip: a record points outside the file');
    }
    return file.slice(start, end).bytes();
  };

  // The end-of-central-directory record is 22 bytes followed by a comment of up to 65535, so it
  // is somewhere in the last 22 + 65535 bytes; the ZIP64 locator, when present, sits just before.
  const tailStart = Math.max(0, fileSize - (EOCD_SIZE + MAX_U16 + EOCD64_LOCATOR_SIZE));
  const tail = await range(tailStart, fileSize);
  const tailView = viewOf(tail);
  let eocd = -1;
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (
      tailView.getUint32(i, true) === SIG_EOCD &&
      i + EOCD_SIZE + tailView.getUint16(i + 20, true) <= tail.length
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveError('not a zip archive (no end-of-central-directory record)');

  let count = tailView.getUint16(eocd + 10, true);
  let directorySize = tailView.getUint32(eocd + 12, true);
  let directoryOffset = tailView.getUint32(eocd + 16, true);

  const locatorAt = tailStart + eocd - EOCD64_LOCATOR_SIZE;
  if (
    (count === MAX_U16 || directorySize === MAX_U32 || directoryOffset === MAX_U32) &&
    locatorAt >= 0
  ) {
    const locator = viewOf(await range(locatorAt, locatorAt + EOCD64_LOCATOR_SIZE));
    // A saturated field without a locator is an archive that really holds 65535 entries.
    if (locator.getUint32(0, true) === SIG_EOCD64_LOCATOR) {
      const recordAt = u64(locator, 8);
      const record = viewOf(await range(recordAt, recordAt + EOCD64_SIZE));
      if (record.getUint32(0, true) !== SIG_EOCD64) {
        throw new ArchiveError('zip: the ZIP64 end record is missing');
      }
      count = u64(record, 32);
      directorySize = u64(record, 40);
      directoryOffset = u64(record, 48);
    }
  }

  if (count > limits.maxEntries) {
    throw new ArchiveError(
      `zip holds ${count} entries, more than the ${limits.maxEntries} allowed`,
    );
  }
  if (directorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw new ArchiveError('zip: the central directory is implausibly large');
  }

  const directory = await range(directoryOffset, directoryOffset + directorySize);
  const view = viewOf(directory);
  const records = new Map<string, ZipRecord>();
  const rejected: string[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + CENTRAL_HEADER_SIZE > directory.length || view.getUint32(p, true) !== SIG_CENTRAL) {
      throw new ArchiveError('zip: the central directory is corrupt');
    }
    const madeBy = view.getUint16(p + 4, true);
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const time = view.getUint16(p + 12, true);
    const date = view.getUint16(p + 14, true);
    const crc = view.getUint32(p + 16, true);
    let compressedSize = view.getUint32(p + 20, true);
    let size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const externalAttributes = view.getUint32(p + 38, true);
    let localOffset = view.getUint32(p + 42, true);

    const nameStart = p + CENTRAL_HEADER_SIZE;
    const extraEnd = nameStart + nameLength + extraLength;
    const next = extraEnd + commentLength;
    if (next > directory.length) throw new ArchiveError('zip: the central directory is corrupt');
    // Names are decoded as UTF-8 whether or not the flag says so: it is what every current tool
    // writes, and the flag's absence usually means an old tool, not CP437.
    const rawName = utf8.decode(directory.subarray(nameStart, nameStart + nameLength));

    // ZIP64 extended information holds only the fields whose 32-bit slots are saturated, in
    // this order.
    for (let q = nameStart + nameLength; q + 4 <= extraEnd; ) {
      const id = view.getUint16(q, true);
      const length = view.getUint16(q + 2, true);
      if (id === EXTRA_ZIP64) {
        let field = q + 4;
        const fieldEnd = Math.min(field + length, extraEnd);
        if (size === MAX_U32 && field + 8 <= fieldEnd) {
          size = u64(view, field);
          field += 8;
        }
        if (compressedSize === MAX_U32 && field + 8 <= fieldEnd) {
          compressedSize = u64(view, field);
          field += 8;
        }
        if (localOffset === MAX_U32 && field + 8 <= fieldEnd) localOffset = u64(view, field);
      }
      q += 4 + length;
    }
    p = next;

    const isDirectory = rawName.endsWith('/') || rawName.endsWith('\\');
    const path = safeEntryPath(rawName);
    if (path === null) {
      // A bare "./" directory entry names the root, which is not a refusal worth reporting.
      if (!isDirectory) rejected.push(rawName);
      continue;
    }

    const isSymlink =
      madeBy >> 8 === HOST_UNIX && ((externalAttributes >>> 16) & S_IFMT) === S_IFLNK;
    const unreadable =
      flags & FLAG_ENCRYPTED
        ? 'encrypted'
        : isSymlink
          ? 'symlink'
          : !isDirectory && method !== METHOD_STORE && method !== METHOD_DEFLATE
            ? `compression method ${method} is not supported`
            : undefined;

    records.set(path, {
      entry: {
        path,
        isDirectory,
        size: isDirectory ? 0 : size,
        modifiedAt: dosDate(date, time),
        ...(unreadable ? { unreadable } : {}),
      },
      method,
      crc,
      compressedSize,
      localOffset,
    });
  }

  async function read(path: string): Promise<Uint8Array> {
    const record = records.get(path);
    if (!record) throw new ArchiveError(`no entry "${path}" in the archive`);
    const { entry } = record;
    if (entry.isDirectory) throw new ArchiveError(`"${path}" is a directory in the archive`);
    if (entry.unreadable) throw new ArchiveError(`"${path}" cannot be read: ${entry.unreadable}`);
    if (entry.size > limits.maxEntryBytes) {
      throw new ArchiveError(
        `"${path}" is ${entry.size} bytes, more than the ${limits.maxEntryBytes} one entry may inflate to`,
      );
    }
    if (record.method === METHOD_STORE && record.compressedSize !== entry.size) {
      throw new ArchiveError(`"${path}" is stored, but its two declared sizes disagree`);
    }

    const header = viewOf(await range(record.localOffset, record.localOffset + LOCAL_HEADER_SIZE));
    if (header.getUint32(0, true) !== SIG_LOCAL) {
      throw new ArchiveError(`zip: the local header of "${path}" is missing`);
    }
    // The local header's own name and extra lengths can differ from the central directory's.
    const dataStart =
      record.localOffset +
      LOCAL_HEADER_SIZE +
      header.getUint16(26, true) +
      header.getUint16(28, true);
    const data = await range(dataStart, dataStart + record.compressedSize);

    let bytes: Uint8Array = data;
    if (record.method === METHOD_DEFLATE) {
      try {
        bytes = inflateRawSync(data, { maxOutputLength: Math.max(entry.size, 1) });
      } catch (err) {
        throw new ArchiveError(
          (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
            ? `"${path}" inflates past its declared ${entry.size} bytes`
            : `"${path}" is not valid deflate data`,
        );
      }
    }
    if (bytes.length !== entry.size) {
      throw new ArchiveError(
        `"${path}" is ${bytes.length} bytes, not the ${entry.size} its header declares`,
      );
    }
    if (Bun.hash.crc32(bytes) >>> 0 !== record.crc) {
      throw new ArchiveError(`"${path}" fails its CRC-32 check`);
    }
    return bytes;
  }

  return { entries: [...records.values()].map((r) => r.entry), rejected, read };
}
