/**
 * A streaming zip writer: at most one file in memory at a time, ZIP64 when a size needs it.
 *
 * Streaming is the point. An archive of a dataset folder can be many times larger than the memory
 * available, so bytes go to a sink as they are produced and only the central directory (roughly a
 * hundred bytes per entry) is held until the end.
 *
 * Each local header carries the entry's real CRC-32 and sizes — no data descriptors — which every
 * reader understands, streaming ones included. That needs the CRC before the bytes are written:
 * a file small enough to deflate is read into memory once, and anything larger is stored and read
 * twice, once to checksum and once to write. The second pass is checked against the first, so a
 * file that changes underneath the writer fails the archive rather than corrupting one entry.
 */

import { deflateRawSync } from 'node:zlib';
import { extname } from 'node:path';
import { ArchiveError } from './types.js';
import {
  CENTRAL_HEADER_SIZE,
  EOCD64_LOCATOR_SIZE,
  EOCD64_SIZE,
  EOCD_SIZE,
  EXTRA_ZIP64,
  FLAG_UTF8,
  HOST_UNIX,
  LOCAL_HEADER_SIZE,
  MAX_U16,
  MAX_U32,
  METHOD_DEFLATE,
  METHOD_STORE,
  S_IFREG_644,
  SIG_CENTRAL,
  SIG_EOCD,
  SIG_EOCD64,
  SIG_EOCD64_LOCATOR,
  SIG_LOCAL,
  VERSION_DEFAULT,
  VERSION_ZIP64,
} from './zip-format.js';

export interface ZipInputFile {
  /** Entry name: relative and `/`-separated. Keeping names unique is the caller's job. */
  name: string;
  absolutePath: string;
  modifiedAt?: Date;
}

export interface ZipWriteOptions {
  /** Files up to this size are deflated in memory; larger ones are stored. Default 64 MiB. */
  deflateMaxBytes?: number;
  /** Lower-case extensions, dot included, stored as-is because they are already compressed. */
  storeExtensions?: ReadonlySet<string>;
  /**
   * Write ZIP64 records even where no size needs them — the only way to exercise that path
   * without a 4 GiB fixture.
   */
  forceZip64?: boolean;
}

export type ByteSink = (chunk: Uint8Array) => Promise<void>;

const DEFAULT_DEFLATE_MAX_BYTES = 64 * 1024 * 1024;
const MADE_BY_UNIX = HOST_UNIX << 8;
const utf8 = new TextEncoder();

function dosDateTime(when: Date | undefined): { date: number; time: number } {
  const year = when ? when.getFullYear() : 1980;
  // The format counts years from 1980 in seven bits.
  const d = when && year >= 1980 && year <= 2107 ? when : new Date(1980, 0, 1);
  return {
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

function zip64Extra(values: number[]): Uint8Array {
  const extra = new Uint8Array(4 + values.length * 8);
  const view = new DataView(extra.buffer);
  view.setUint16(0, EXTRA_ZIP64, true);
  view.setUint16(2, values.length * 8, true);
  values.forEach((value, i) => view.setBigUint64(4 + i * 8, BigInt(value), true));
  return extra;
}

export async function writeZip(
  files: ZipInputFile[],
  sink: ByteSink,
  options: ZipWriteOptions = {},
): Promise<{ bytes: number; entries: number }> {
  const deflateMaxBytes = options.deflateMaxBytes ?? DEFAULT_DEFLATE_MAX_BYTES;
  const force = options.forceZip64 === true;
  const central: Uint8Array[] = [];
  let offset = 0;
  const emit = async (chunk: Uint8Array) => {
    await sink(chunk);
    offset += chunk.length;
  };

  for (const input of files) {
    const name = utf8.encode(input.name);
    if (name.length > MAX_U16) throw new ArchiveError(`zip: entry name too long: ${input.name}`);
    const file = Bun.file(input.absolutePath);
    const size = file.size;
    const { date, time } = dosDateTime(input.modifiedAt);

    let method = METHOD_STORE;
    let crc = 0;
    let compressedSize = size;
    // The payload when it was built in memory; null means stream the file.
    let body: Uint8Array | null = null;
    const deflatable =
      size <= deflateMaxBytes && !options.storeExtensions?.has(extname(input.name).toLowerCase());
    if (deflatable) {
      const raw = await file.bytes();
      crc = Bun.hash.crc32(raw) >>> 0;
      const deflated = deflateRawSync(raw);
      if (deflated.length < raw.length) {
        method = METHOD_DEFLATE;
        body = deflated;
      } else {
        body = raw;
      }
      compressedSize = body.length;
    } else {
      for await (const chunk of file.stream()) crc = Bun.hash.crc32(chunk, crc) >>> 0;
    }

    const localOffset = offset;
    const sizeWide = force || size >= MAX_U32;
    const compressedWide = force || compressedSize >= MAX_U32;
    const offsetWide = force || localOffset >= MAX_U32;

    // With a ZIP64 extra, a local header must carry both sizes there, and saturate both slots.
    const localZip64 = sizeWide || compressedWide;
    const localExtra = localZip64 ? zip64Extra([size, compressedSize]) : new Uint8Array(0);
    const local = new Uint8Array(LOCAL_HEADER_SIZE + name.length + localExtra.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, localZip64 ? VERSION_ZIP64 : VERSION_DEFAULT, true);
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, localZip64 ? MAX_U32 : compressedSize, true);
    lv.setUint32(22, localZip64 ? MAX_U32 : size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, localExtra.length, true);
    local.set(name, LOCAL_HEADER_SIZE);
    local.set(localExtra, LOCAL_HEADER_SIZE + name.length);
    await emit(local);

    if (body) {
      await emit(body);
    } else {
      let written = 0;
      let rechecked = 0;
      for await (const chunk of file.stream()) {
        await emit(chunk);
        written += chunk.length;
        rechecked = Bun.hash.crc32(chunk, rechecked) >>> 0;
      }
      if (written !== size || rechecked !== crc) {
        throw new ArchiveError(`"${input.name}" changed while it was being archived`);
      }
    }

    // The central record's ZIP64 extra holds only the saturated fields, in this order.
    const wideFields = [
      ...(sizeWide ? [size] : []),
      ...(compressedWide ? [compressedSize] : []),
      ...(offsetWide ? [localOffset] : []),
    ];
    const version = wideFields.length > 0 ? VERSION_ZIP64 : VERSION_DEFAULT;
    const centralExtra = wideFields.length > 0 ? zip64Extra(wideFields) : new Uint8Array(0);
    const record = new Uint8Array(CENTRAL_HEADER_SIZE + name.length + centralExtra.length);
    const cv = new DataView(record.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, MADE_BY_UNIX | version, true);
    cv.setUint16(6, version, true);
    cv.setUint16(8, FLAG_UTF8, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressedWide ? MAX_U32 : compressedSize, true);
    cv.setUint32(24, sizeWide ? MAX_U32 : size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, centralExtra.length, true);
    // Comment length, disk number and internal attributes stay zero.
    cv.setUint32(38, (S_IFREG_644 << 16) >>> 0, true);
    cv.setUint32(42, offsetWide ? MAX_U32 : localOffset, true);
    record.set(name, CENTRAL_HEADER_SIZE);
    record.set(centralExtra, CENTRAL_HEADER_SIZE + name.length);
    central.push(record);
  }

  const directoryOffset = offset;
  await emit(Buffer.concat(central));
  const directorySize = offset - directoryOffset;
  const count = central.length;

  const wide = force || count >= MAX_U16 || directorySize >= MAX_U32 || directoryOffset >= MAX_U32;
  if (wide) {
    const recordOffset = offset;
    const end = new Uint8Array(EOCD64_SIZE + EOCD64_LOCATOR_SIZE);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, SIG_EOCD64, true);
    ev.setBigUint64(4, BigInt(EOCD64_SIZE - 12), true);
    ev.setUint16(12, MADE_BY_UNIX | VERSION_ZIP64, true);
    ev.setUint16(14, VERSION_ZIP64, true);
    // Disk numbers (16, 20) stay zero.
    ev.setBigUint64(24, BigInt(count), true);
    ev.setBigUint64(32, BigInt(count), true);
    ev.setBigUint64(40, BigInt(directorySize), true);
    ev.setBigUint64(48, BigInt(directoryOffset), true);
    ev.setUint32(EOCD64_SIZE, SIG_EOCD64_LOCATOR, true);
    ev.setBigUint64(EOCD64_SIZE + 8, BigInt(recordOffset), true);
    ev.setUint32(EOCD64_SIZE + 16, 1, true);
    await emit(end);
  }

  const eocd = new Uint8Array(EOCD_SIZE);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, SIG_EOCD, true);
  dv.setUint16(8, wide ? MAX_U16 : count, true);
  dv.setUint16(10, wide ? MAX_U16 : count, true);
  dv.setUint32(12, wide ? MAX_U32 : directorySize, true);
  dv.setUint32(16, wide ? MAX_U32 : directoryOffset, true);
  await emit(eocd);

  return { bytes: offset, entries: count };
}
