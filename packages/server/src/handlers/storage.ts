/**
 * Storage domain handler for the verb layer.
 *
 * Maps verbs to operations on persistent storage:
 *   read   → read file contents
 *   list   → list directory entries
 *   invoke → write or edit (dispatched by payload.action)
 *   delete → delete a file
 */

import { parseFileUri } from '@yaar/shared';
import type { ResourceRegistry, VerbResult, ReadOptions } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import {
  storageRead,
  storageWrite,
  storageList,
  storageDelete,
  storageGrep,
} from '../storage/index.js';
import { ok, okJson, okWithImages, okResource, okLinks, error } from './utils.js';
import { prependNote, applyEdit, applyReadOptions, mimeFromPath } from './utils.js';
import { copyStorageBytes, decodeWriteContent } from './storage-bytes.js';
import {
  COPY_ACTION,
  COPY_FROM_REQUIRED,
  COPY_FROM_SCHEMA,
  copyFrom,
  isCopyPayload,
} from './storage-copy.js';
import { describeStoragePath } from './storage-describe.js';

// ── Helpers ──

async function readStorageRaw(path: string): Promise<{ content: string } | { error: string }> {
  const { resolvePath } = await import('../storage/storage-manager.js');
  const resolved = resolvePath(path);
  if (!resolved) return { error: 'Invalid storage path.' };
  try {
    const content = await Bun.file(resolved.absolutePath).text();
    return { content };
  } catch {
    return { error: `File not found: ${path}` };
  }
}

// ── Registration ──

export function registerStorageHandlers(registry: ResourceRegistry): void {
  registry.register('yaar://storage/*', {
    description:
      'Persistent storage file. Read to view contents, list to browse directory, ' +
      'invoke with action "write", "copy" or "edit" to modify, delete to remove. ' +
      'Reserved prefixes: "media/" (artifacts shared between apps — publish here to hand ' +
      'an image to another app), "temp/" (scratch, safe to prune), "files/" (user documents), ' +
      'and "apps/{id}/" (an app\'s private storage — also spelled yaar://apps/{id}/storage/). ' +
      'To move a file, prefer action "copy" over reading it and writing it back: copy moves ' +
      'the bytes server-side, a read/write round-trip drags them through the conversation.',
    verbs: ['describe', 'read', 'list', 'invoke', 'delete'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['write', COPY_ACTION, 'edit', 'grep'] },
        pattern: { type: 'string', description: 'Regex pattern to search for (grep)' },
        glob: { type: 'string', description: 'Glob pattern to filter files (grep)' },
        content: { type: 'string', description: 'File content (for write)' },
        encoding: {
          type: 'string',
          enum: ['base64'],
          description:
            'Set to "base64" when "content" is base64-encoded binary (images, PDFs). ' +
            'Omit for text. Writing binary without it stores the base64 text itself.',
        },
        from: COPY_FROM_SCHEMA,
        old_string: { type: 'string', description: 'Text to find (edit string mode)' },
        new_string: { type: 'string', description: 'Replacement text (edit)' },
        start_line: {
          type: 'number',
          description: 'First line to replace (edit line mode, 1-based)',
        },
        end_line: {
          type: 'number',
          description: 'Last line to replace (edit line mode, 1-based, inclusive)',
        },
      },
    },

    async describe(resolved: ResolvedUri): Promise<VerbResult> {
      const parsed = parseFileUri(resolved.sourceUri);
      if (!parsed && resolved.sourceUri !== 'yaar://storage') return error('Invalid storage URI.');
      return describeStoragePath(resolved.sourceUri, parsed?.path ?? '');
    },

    async read(resolved: ResolvedUri, options?: ReadOptions): Promise<VerbResult> {
      const parsed = parseFileUri(resolved.sourceUri);
      if (!parsed) {
        if (resolved.sourceUri === 'yaar://storage')
          return this.list!(resolved).then((r) =>
            prependNote(r, 'This is a folder — used list instead.'),
          );
        return error('Invalid storage URI.');
      }
      if (!parsed.path)
        return this.list!(resolved).then((r) =>
          prependNote(r, 'This is a folder — used list instead.'),
        );

      const result = await storageRead(parsed.path, {
        pdfText: options?.pdfText,
        pdfPages: options?.pdfPages,
        rawImage: options?.rawImage,
      });
      if (!result.success) {
        // Directory → fall through to list
        if (result.error?.includes('is a directory'))
          return this.list!(resolved).then((r) =>
            prependNote(r, 'This is a folder — used list instead.'),
          );
        return error(result.error!);
      }

      // PDF, metadata only (view-first default): steer to a viewer window instead of ingesting.
      if (result.pdfMeta) {
        return ok(
          `${result.content}\n\nTo SHOW this PDF to the user, open it in a window — the ` +
            `browser renders it natively, no need to read it:\n` +
            `  invoke('yaar://windows/<id>', { action: 'create', renderer: 'iframe', ` +
            `content: 'yaar://storage/${parsed.path}' })\n` +
            `To READ the content yourself, re-read with one of:\n` +
            `  read('yaar://storage/${parsed.path}', { pdfText: true })   — extract the text layer (cheap, all pages)\n` +
            `  read('yaar://storage/${parsed.path}', { pdfPages: '1-3' }) — rasterize pages to images (scanned/visual PDFs)`,
        );
      }

      if (result.images && result.images.length > 0) {
        const isPdf = result.totalPages != null;
        const hint = isPdf
          ? `\n\nThese are rasterized page images. To display the PDF to the user, open an iframe window with content="yaar://storage/${parsed.path}" instead.`
          : '';
        return okWithImages(
          result.content! + hint,
          result.images.map((img: { data: string; mimeType: string }) => ({
            data: img.data,
            mimeType: img.mimeType,
          })),
        );
      }

      // Apply line range / pattern filtering for text files — return as embedded resource
      const text = applyReadOptions(result.content!, parsed.path, options);
      return okResource(`yaar://storage/${parsed.path}`, text, mimeFromPath(parsed.path));
    },

    async list(resolved: ResolvedUri): Promise<VerbResult> {
      const parsed = parseFileUri(resolved.sourceUri);
      // Bare yaar://storage (no trailing /) — treat as root listing
      const path = parsed ? parsed.path : resolved.sourceUri === 'yaar://storage' ? '' : null;
      if (path === null) return error('Invalid storage URI.');

      const result = await storageList(path);
      if (!result.success) {
        // storageList returns error for files — fall through to read
        if (result.error?.includes('is a file')) {
          return this.read!(resolved).then((r) =>
            prependNote(r, 'This is a file — used read instead.'),
          );
        }
        return error(result.error!);
      }

      const entries = result.entries!;
      // A listing URI may arrive with a trailing slash (`yaar://storage/mounts/`),
      // and `${path}/` would then be `mounts//` — one character longer than the
      // prefix the entry paths actually carry, so every child name lost its first
      // character ("mounts/toolresults" listed as "oolresults"). Normalize first.
      const base = path.replace(/\/+$/, '');
      const prefix = base ? `${base}/` : '';
      return okLinks(
        entries.map((e) => ({
          uri: `yaar://storage/${e.path}`,
          name: e.path.slice(prefix.length) || e.path,
          description: e.isDirectory ? 'directory' : `${e.size ?? 0} bytes`,
          mimeType: e.isDirectory ? undefined : mimeFromPath(e.path),
        })),
      );
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      const parsed = parseFileUri(resolved.sourceUri);
      if (!parsed && resolved.sourceUri !== 'yaar://storage') return error('Invalid storage URI.');
      if (!payload?.action) return error('Payload must include "action" ("write" or "edit").');

      const action = payload.action as string;
      const path = parsed?.path ?? '';

      if (action === 'write') {
        if (!path) return error('Cannot write to storage root. Provide a file path.');
        const decoded = decodeWriteContent(payload);
        if ('error' in decoded) return error(decoded.error);
        const result = await storageWrite(path, decoded.content);
        if (!result.success) return error(result.error!);
        return ok(`Written to yaar://storage/${path}`);
      }

      if (isCopyPayload(payload)) {
        if (!path) return error('Cannot copy onto the storage root. Provide a destination path.');
        // The same field `POST /api/verb` checks `read` on before dispatching here —
        // see handlers/storage-copy.ts. This handler authorizes nothing itself.
        const from = copyFrom(payload);
        if (from === null) return error(COPY_FROM_REQUIRED);
        const copied = await copyStorageBytes(from, path);
        if ('error' in copied) return error(copied.error);
        return ok(`Copied ${from} → yaar://storage/${path} (${copied.bytes} bytes)`);
      }

      if (action === 'edit') {
        if (!path) return error('Provide a file path to edit.');
        const raw = await readStorageRaw(path);
        if ('error' in raw) return error(raw.error);

        const edited = await applyEdit(raw.content, payload);
        if ('error' in edited) return error(edited.error);

        const writeResult = await storageWrite(path, edited.result);
        if (!writeResult.success) return error(writeResult.error!);
        return ok(`Edited yaar://storage/${path}`);
      }

      if (action === 'grep') {
        if (typeof payload.pattern !== 'string')
          return error('"pattern" (string) is required for grep.');
        const result = await storageGrep(path, payload.pattern, payload.glob as string | undefined);
        if (!result.success) return error(result.error!);
        return okJson({ matches: result.matches, truncated: result.truncated });
      }

      return error(`Unknown action "${action}". Use "write", "copy", "edit", or "grep".`);
    },

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      const parsed = parseFileUri(resolved.sourceUri);
      const path = parsed?.path ?? '';
      if (!parsed && resolved.sourceUri !== 'yaar://storage') return error('Invalid storage URI.');
      if (!path) return error('Provide a file path to delete.');
      const result = await storageDelete(path);
      if (!result.success) return error(result.error!);
      return ok(`Deleted yaar://storage/${path}`);
    },
  });
}
