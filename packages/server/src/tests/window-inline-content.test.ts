/**
 * A `yaar://storage/…` given to a text renderer is the document, not the text.
 *
 * `renderer: "iframe"` has always taken a URI as its `content`, so the obvious next
 * thing to write — `renderer: "markdown", content: "yaar://storage/plan.md"` — used to
 * succeed, report success, and put a window on screen whose body was the literal string
 * `yaar://storage/plan.md`. The stored content was the URI too, so `read` on the window
 * agreed with the wrong picture rather than exposing it (GitHub issue #87).
 *
 * These tests pin the resolution and, just as importantly, the four refusals. The
 * gate one is the load-bearing check: `window.create` is reachable over `POST /api/verb`
 * by any app declaring `yaar://windows/`, so a server that reads files into windows on
 * request is a storage-wide read for every such app unless the caller already outranked
 * it. See features/window/inline-content.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { STORAGE_DIR } from '../config.js';
import { namesInlinableUri, inlineUriContent } from '../features/window/inline-content.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import { actionEmitter, type ActionEvent } from '../session/action-emitter.js';
import { handleCreate } from '../features/window/create.js';
import type { SessionId } from '../session/types.js';

const DOC = '# Hello\n\nsome content\n';

/** As a monitor agent: unconfined, so it may have a file read on its behalf. */
function asAgent<T>(fn: () => T): T {
  return runWithAgentContext(
    {
      agentId: 'agent-m0',
      sessionId: 'test-session' as SessionId,
      monitorId: '0',
      role: 'monitor',
    },
    fn,
  );
}

/** As an app iframe calling POST /api/verb: an appId and no agent role. */
function asApp<T>(fn: () => T): T {
  return runWithAgentContext(
    {
      agentId: 'iframe:notes',
      sessionId: 'test-session' as SessionId,
      monitorId: '0',
      appId: 'notes',
    },
    fn,
  );
}

beforeAll(async () => {
  await mkdir(join(STORAGE_DIR, 'files'), { recursive: true });
  await writeFile(join(STORAGE_DIR, 'files/plan.md'), DOC);
  await writeFile(join(STORAGE_DIR, 'files/shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(STORAGE_DIR, 'files/big.md'), 'x'.repeat(600 * 1024));
});

afterAll(async () => {
  await rm(join(STORAGE_DIR, 'files'), { recursive: true, force: true });
});

describe('namesInlinableUri', () => {
  it('claims a URI given to each text renderer', () => {
    for (const renderer of ['markdown', 'text', 'html']) {
      expect(namesInlinableUri(renderer, 'yaar://storage/files/plan.md')).toBe(true);
    }
  });

  it('leaves iframe alone — it resolves URIs to a URL, not to bytes', () => {
    expect(namesInlinableUri('iframe', 'yaar://storage/files/plan.md')).toBe(false);
    expect(namesInlinableUri('iframe', 'yaar://apps/memo')).toBe(false);
  });

  it('ignores ordinary content, and structured content that could never be a URI', () => {
    expect(namesInlinableUri('markdown', '# Hello')).toBe(false);
    expect(namesInlinableUri('markdown', 'see yaar://storage/plan.md for details')).toBe(false);
    expect(namesInlinableUri('table', { headers: ['a'], rows: [['b']] })).toBe(false);
    expect(namesInlinableUri(undefined, 'yaar://storage/files/plan.md')).toBe(false);
  });
});

describe('inlineUriContent', () => {
  it('returns the file, not the pointer', async () => {
    const result = await asAgent(() =>
      inlineUriContent('markdown', 'yaar://storage/files/plan.md'),
    );
    expect(result).toEqual({ ok: true, data: DOC });
  });

  it('reads the app-scoped spelling of the same tree', async () => {
    await mkdir(join(STORAGE_DIR, 'apps/notes'), { recursive: true });
    await writeFile(join(STORAGE_DIR, 'apps/notes/note.md'), 'note body');
    const result = await asAgent(() =>
      inlineUriContent('text', 'yaar://apps/notes/storage/note.md'),
    );
    expect(result).toEqual({ ok: true, data: 'note body' });
    await rm(join(STORAGE_DIR, 'apps'), { recursive: true, force: true });
  });

  it('refuses an app caller rather than reading on its behalf', async () => {
    // The escalation this would otherwise be: any app declaring yaar://windows/ could
    // name any file and read it back out of the window it just created.
    const result = await asApp(() => inlineUriContent('markdown', 'yaar://storage/files/plan.md'));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('Read the file yourself');
  });

  it('refuses a URI that names no storage file', async () => {
    const result = await asAgent(() => inlineUriContent('markdown', 'yaar://apps/memo'));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('iframe');
  });

  it('refuses a file that is not text', async () => {
    const result = await asAgent(() =>
      inlineUriContent('markdown', 'yaar://storage/files/shot.png'),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('not a text file');
  });

  it('says so when the file is missing, instead of creating an empty window', async () => {
    const result = await asAgent(() =>
      inlineUriContent('markdown', 'yaar://storage/files/gone.md'),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('names no file');
  });

  it('refuses a document too big to hold in window state', async () => {
    const result = await asAgent(() => inlineUriContent('markdown', 'yaar://storage/files/big.md'));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('KB a window may hold');
  });
});

describe('handleCreate', () => {
  /** The window.create action a call emits, or undefined if it emitted none. */
  async function emittedBy(payload: Record<string, unknown>) {
    const seen: ActionEvent[] = [];
    const listen = (e: ActionEvent) => seen.push(e);
    actionEmitter.on('action', listen);
    try {
      const result = await asAgent(() => handleCreate('', payload));
      return { result, action: seen.at(-1)?.action };
    } finally {
      actionEmitter.off('action', listen);
    }
  }

  it('emits the file text, so the window holds what it displays', async () => {
    // The whole point of resolving server-side: read("yaar://windows/plan") and the
    // reload cache see the document, not a pointer that renders as its own name.
    const { result, action } = await emittedBy({
      title: 'Plan',
      renderer: 'markdown',
      content: 'yaar://storage/files/plan.md',
    });
    expect(result.isError).toBeUndefined();
    expect(action).toMatchObject({
      type: 'window.create',
      content: { renderer: 'markdown', data: DOC },
    });
  });

  it('opens no window at all when the file cannot be read', async () => {
    // The reported failure was a create that reported success — a refusal that still
    // put a window on the desktop would only move the lie.
    const { result, action } = await emittedBy({
      title: 'Gone',
      renderer: 'markdown',
      content: 'yaar://storage/files/gone.md',
    });
    expect(result.isError).toBe(true);
    expect(action).toBeUndefined();
  });

  it('leaves ordinary markdown untouched', async () => {
    const { action } = await emittedBy({
      title: 'Notes',
      renderer: 'markdown',
      content: '# Hello',
    });
    expect(action).toMatchObject({ content: { renderer: 'markdown', data: '# Hello' } });
  });
});
