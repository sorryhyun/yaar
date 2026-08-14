/**
 * Content-addressed blob sidecar for session logs.
 *
 * A session log is an event log: the thing you replay a session from. That only works
 * if a heavy result — an image, an HTTP body, a source file — is recorded as the bytes
 * that were actually returned, not as a path that may since have changed underneath it.
 * Inlining them into `messages.jsonl` records the right bytes but buries the entries
 * the log exists to show, so anything past `BLOB_THRESHOLD_BYTES` moves out of line:
 * the JSONL keeps a `BlobRef` (hash, size, mime, short preview) and the bytes land in
 * `<session>/blobs/<sha256>`, resolved on read via `yaar://history/{id}/blobs/{sha256}`.
 *
 * Addressed by content hash rather than a minted id, for two reasons:
 *
 *  - **Repeats collapse.** Apps re-read the same resources constantly — one measured
 *    session made 10,733 devtools verb calls carrying 318 distinct payloads, the top
 *    one a `read` of the same `main.ts` 124 times. Under a per-call id that is 124
 *    copies; under the hash it is one file and 123 skipped writes.
 *  - **A change is visible as a change.** Two reads of one path that return different
 *    bytes get different hashes, so the log shows the resource changed. Minted ids
 *    record two opaque blobs and leave you to diff them to find out.
 *
 * The store is per-session, so a session directory stays self-contained — it can be
 * copied or archived whole and still replay. A process-wide store would dedupe across
 * sessions, but then pruning one log means refcounting against every other, and no
 * single directory is the session any more.
 */

import { mkdir } from 'fs/promises';
import { join } from 'path';

/**
 * Content at or below this many bytes stays inline in the JSONL.
 *
 * Sized against real logs: the median tool result is ~120 bytes and p90 is ~2.6KB, so
 * this keeps the overwhelming majority of entries readable in place and moves out the
 * tail that accounts for the bulk of the bytes.
 */
export const BLOB_THRESHOLD_BYTES = 2048;

/** How much of an offloaded value stays inline, so the log reads without resolving blobs. */
export const BLOB_PREVIEW_CHARS = 200;

/** Pointer to bytes held in the session's blob store. Replaces `content` when it is large. */
export interface BlobRef {
  /** Hex sha256 of the stored bytes — also the filename under `<session>/blobs/`. */
  sha256: string;
  /** Byte length of the stored content. */
  bytes: number;
  /** Detected media type, when the content announced one (e.g. a data-URL image). */
  mimeType?: string;
  /** Leading characters, so a reader can tell what this is without fetching it. */
  preview?: string;
}

/** Directory holding one session's blobs. */
export function blobDir(sessionDirectory: string): string {
  return join(sessionDirectory, 'blobs');
}

/** Path of one blob within a session. */
export function blobPath(sessionDirectory: string, sha256: string): string {
  return join(blobDir(sessionDirectory), sha256);
}

/**
 * A blob name is used as a filename, so it must be exactly a hex digest and nothing
 * else — this is what stops `yaar://history/{id}/blobs/../../etc/passwd` from resolving.
 */
export function isBlobRef(name: string): boolean {
  return /^[0-9a-f]{64}$/.test(name);
}

export function hashContent(content: string): string {
  return new Bun.CryptoHasher('sha256').update(content).digest('hex');
}

/** Media type of a data URL, when the content is one. */
function detectMimeType(content: string): string | undefined {
  const match = /^data:([\w.+-]+\/[\w.+-]+)[;,]/.exec(content.slice(0, 128));
  return match?.[1];
}

/**
 * Decide whether a value stays inline or moves to the blob store.
 *
 * Returns the `BlobRef` to log plus the bytes to write, or `null` when the content is
 * small enough to keep in place. Pure and synchronous — the caller buffers the write,
 * so this can sit on the hot logging path without awaiting the filesystem.
 */
export function offloadContent(content: string): { ref: BlobRef; bytes: string } | null {
  // Byte length, not string length: the threshold is about what lands on disk, and a
  // CJK or emoji-heavy result is several times its character count once encoded.
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength <= BLOB_THRESHOLD_BYTES) return null;

  const mimeType = detectMimeType(content);
  const ref: BlobRef = {
    sha256: hashContent(content),
    bytes: byteLength,
    ...(mimeType ? { mimeType } : {}),
    // A base64 data URL previews as meaningless padding, so carry the declared type
    // instead of 200 characters of it.
    ...(mimeType
      ? {}
      : {
          preview:
            content.slice(0, BLOB_PREVIEW_CHARS) + (content.length > BLOB_PREVIEW_CHARS ? '…' : ''),
        }),
  };
  return { ref, bytes: content };
}

/**
 * Write blobs that are not already stored. Returns the hashes actually written.
 *
 * `known` is the set of hashes this session has already stored; it is consulted first
 * so the common case — the same resource read again — costs a set lookup rather than a
 * stat. It is mutated to include everything written.
 */
export async function writeBlobs(
  sessionDirectory: string,
  blobs: Map<string, string>,
  known: Set<string>,
): Promise<string[]> {
  const pending = [...blobs.entries()].filter(([sha]) => !known.has(sha));
  if (pending.length === 0) return [];

  await mkdir(blobDir(sessionDirectory), { recursive: true });

  const written: string[] = [];
  await Promise.all(
    pending.map(async ([sha, bytes]) => {
      const path = blobPath(sessionDirectory, sha);
      // Content-addressed: a file already at this path holds these exact bytes, so a
      // second write would be a byte-identical no-op. Skip it — across a session of
      // repeated reads this is the majority of calls.
      if (await Bun.file(path).exists()) {
        known.add(sha);
        return;
      }
      await Bun.write(path, bytes);
      known.add(sha);
      written.push(sha);
    }),
  );
  return written;
}
