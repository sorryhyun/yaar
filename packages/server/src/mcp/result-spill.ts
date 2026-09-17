/**
 * Spill an oversized verb result into storage instead of letting the CLI persist it.
 *
 * ## Why YAAR writes the file itself
 *
 * Past its per-tool threshold (`mcp/result-size.ts`) Claude Code writes a result to
 * `{CLAUDE_CONFIG_DIR}/projects/{key}/{session}/tool-results/` and hands the model a 2 KB
 * preview plus that path. No YAAR principal can read that path, and there is no knob that
 * moves only that directory — the CLI derives it from `CLAUDE_CONFIG_DIR`, which also moves
 * every transcript, so pointing it into storage would expose every agent's conversation to
 * every other agent. Codex has no such fallback at all.
 *
 * So the verb door never gets that far: a result over {@link SPILL_THRESHOLD_CHARS} is
 * written to `yaar://storage/temp/tool-results/`, where the agent that asked already has
 * `read`, and the model gets a preview plus the URI and how to page it (`chars`, see
 * `applyReadOptions`). The text is lossless and stays inside the agent's own permissions.
 *
 * ## Why 100,000 and not the 150,000 the tools declare
 *
 * The declaration is per tool; the CLI also caps the tool results of one assistant message at
 * ~200,000 characters together, persisting the largest first. Spilling at 100,000 keeps two
 * sibling calls in a turn from tripping that pass, and leaves room for the layout context
 * `appendLayoutContext` adds after this.
 *
 * ## Scope
 *
 * The five-verb door only (`handlers/index.ts`'s `exec`) — monitor agents and sub-agents.
 * `POST /api/verb` never passes through it: an app's SDK call wants its data, not a pointer.
 * Results carrying an image or a binary blob are left alone; their size is not text a
 * `chars` read could page back.
 */
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { VerbResult } from '../handlers/uri-registry.js';
import { CHAR_PAGE_SIZE } from '../handlers/utils.js';
import { resolvePath, storageWrite } from '../storage/storage-manager.js';

export const SPILL_THRESHOLD_CHARS = 100_000;

/** Storage-relative directory spilled results land in. `temp/` is scratch, safe to prune. */
export const SPILL_DIR = 'temp/tool-results';

const SPILL_URI_PREFIX = `yaar://storage/${SPILL_DIR}/`;

/** How long a spilled result is kept. Long enough to outlive the turn that reads it back. */
const SPILL_TTL_MS = 24 * 60 * 60 * 1000;

const PREVIEW_CHARS = 2_000;

/**
 * The text a model would read from `result`, or null when it cannot be spilled as text.
 *
 * Beside `structuredContent` the text blocks never reach a model (see `VerbResult`), so
 * that object is what gets spilled when it is set.
 */
function modelText(result: VerbResult): string | null {
  if (result.structuredContent) return JSON.stringify(result.structuredContent, null, 2);
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'resource_link') parts.push(`${block.name} ${block.uri}`);
    else if (block.type === 'resource' && 'text' in block.resource) parts.push(block.resource.text);
    else return null;
  }
  return parts.join('\n');
}

/**
 * The size the CLI measures: the content array as pretty-printed JSON, which is how it
 * persists one. `structuredContent` is counted too — it is what the model is handed.
 */
function serializedSize(result: VerbResult): number {
  const content = JSON.stringify(result.content, null, 2).length;
  const structured = result.structuredContent ? JSON.stringify(result.structuredContent).length : 0;
  return Math.max(content, structured);
}

/** Delete spilled results older than {@link SPILL_TTL_MS}. Best-effort. */
async function pruneSpills(now: number): Promise<void> {
  const dir = resolvePath(SPILL_DIR)?.absolutePath;
  if (!dir) return;
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names.map(async (name) => {
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile() && now - info.mtimeMs > SPILL_TTL_MS) await unlink(path).catch(() => {});
    }),
  );
}

function spillName(verb: string, now: Date, json: boolean): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${verb}-${rand}.${json ? 'json' : 'txt'}`;
}

const STORAGE_FILE_URI = /^yaar:\/\/(storage|apps\/[^/]+\/storage)\//;

/**
 * The URI to point at when `result` is a read of a storage file — the file is already where
 * the agent can page it, so copying it would only add the read's line-number gutter to the
 * text `chars` then slices. Null for anything else.
 */
function storageFileRead(verb: string, uris: string[], result: VerbResult): string | null {
  if (verb !== 'read' || uris.length !== 1 || !STORAGE_FILE_URI.test(uris[0])) return null;
  if (uris[0].startsWith(SPILL_URI_PREFIX)) return uris[0];
  const [block, ...rest] = result.content;
  return rest.length === 0 && block?.type === 'resource' && block.resource.uri === uris[0]
    ? uris[0]
    : null;
}

/**
 * `result` as is when it fits; otherwise a pointer to a storage copy of it.
 *
 * `uris` are the URIs the call named — a read of a storage file, or of a result that was
 * already spilled, is pointed back at that file rather than copied.
 */
export async function spillOversizedResult(
  verb: string,
  uris: string[],
  result: VerbResult,
): Promise<VerbResult> {
  if (serializedSize(result) <= SPILL_THRESHOLD_CHARS) return result;
  const text = modelText(result);
  if (text === null) return result;

  const now = new Date();
  let uri: string;
  const source = storageFileRead(verb, uris, result);
  if (source) {
    uri = source;
  } else {
    const path = `${SPILL_DIR}/${spillName(verb, now, Boolean(result.structuredContent))}`;
    const written = await storageWrite(path, text);
    if (!written.success) return result;
    uri = `yaar://storage/${path}`;
    void pruneSpills(now.getTime());
  }

  const lineCount = text.split('\n').length;
  const lineHint =
    lineCount > 1
      ? `, or narrow it with { pattern: '…' } / { lines: '1-500' } (${lineCount.toLocaleString('en-US')} lines)`
      : '';
  const message =
    `Result too large to return inline (${text.length.toLocaleString('en-US')} chars) — ` +
    `${source ? 'the full text is' : 'saved in full'} at ${uri}\n` +
    `Page through it with read('${uri}', { chars: '0-${CHAR_PAGE_SIZE}' }), then ` +
    `'${CHAR_PAGE_SIZE}-${CHAR_PAGE_SIZE * 2}', …${lineHint}.\n\n` +
    `Preview (first ${PREVIEW_CHARS.toLocaleString('en-US')} chars):\n` +
    text.slice(0, PREVIEW_CHARS);

  return {
    content: [{ type: 'text', text: message }],
    ...(result.isError ? { isError: true } : {}),
  };
}
