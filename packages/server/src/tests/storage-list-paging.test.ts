/**
 * `list` on a storage folder pages and sorts.
 *
 * A mounted folder can hold thousands of entries. Listed whole, the result passed the spill
 * threshold, and the agent got a 2 KB preview of an alphabetical run: no way to reach the
 * rest except by reading the spill file back in chunks, and no way to ask for the newest
 * or largest first. The MCP door now returns a page with a note giving the total and the
 * next range. `POST /api/verb` does not: the Storage app lists a folder to show all of it.
 *
 * The app agent's `storage:list` is the same verb by another spelling — the one an app can
 * override — so its built-in pages and sorts the same way, from the same params.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { symlink, utimes } from 'fs/promises';
import { storageWrite, storageList, resolvePath } from '../storage/storage-manager.js';
import { initRegistry } from '../handlers/index.js';
import type { ResourceRegistry } from '../handlers/uri-registry.js';
import { readFileSync } from 'node:fs';
import { applyListOptions, parseListOptions, LIST_PAGE_SIZE } from '../lib/list-options.js';
import { listAnswer } from '../mcp/app-agent/index.js';
import type { VerbResult } from '../lib/verb-result.js';

const DIR = 'list-paging-fixture';
const COUNT = 12;

function names(result: VerbResult): string[] {
  return result.content.flatMap((b) => (b.type === 'resource_link' ? [b.name] : []));
}

function note(result: VerbResult): string | undefined {
  const first = result.content[0];
  return first?.type === 'text' ? first.text : undefined;
}

const entry = (path: string, size: number, day: number, isDirectory = false) => ({
  path,
  isDirectory,
  size,
  modifiedAt: new Date(Date.UTC(2026, 0, day)).toISOString(),
});

describe('applyListOptions', () => {
  const entries = [
    entry('b.txt', 30, 1),
    entry('a.txt', 10, 3),
    entry('sub', 4096, 2, true),
    entry('c.txt', 20, 4),
  ];

  it('keeps the old order with no options: directories first, then by name', () => {
    const out = applyListOptions(entries);
    if ('error' in out) throw new Error(out.error);
    expect(out.page.map((e) => e.path)).toEqual(['sub', 'a.txt', 'b.txt', 'c.txt']);
    expect(out.note).toBeNull();
  });

  it('sorts by modified newest first, directories mixed in', () => {
    const out = applyListOptions(entries, { sort: 'modified' });
    if ('error' in out) throw new Error(out.error);
    expect(out.page.map((e) => e.path)).toEqual(['c.txt', 'a.txt', 'sub', 'b.txt']);
  });

  it('sorts by size largest first, with directories last — their size is not their contents', () => {
    const out = applyListOptions(entries, { sort: 'size' });
    if ('error' in out) throw new Error(out.error);
    expect(out.page.map((e) => e.path)).toEqual(['b.txt', 'c.txt', 'a.txt', 'sub']);
  });

  it('honours an explicit order', () => {
    const out = applyListOptions(entries, { sort: 'modified', order: 'asc' });
    if ('error' in out) throw new Error(out.error);
    expect(out.page[0].path).toBe('b.txt');
  });

  it('pages by range and says where the next page starts', () => {
    const out = applyListOptions(entries, { range: '2-3' });
    if ('error' in out) throw new Error(out.error);
    expect(out.page.map((e) => e.path)).toEqual(['a.txt', 'b.txt']);
    expect(out.note).toContain('Entries 2-3 of 4');
    expect(out.note).toContain('range "4-4"');
  });

  it('caps at defaultLimit when no range is given', () => {
    const out = applyListOptions(entries, { defaultLimit: 2 });
    if ('error' in out) throw new Error(out.error);
    expect(out.page).toHaveLength(2);
    expect(out.note).toContain('Entries 1-2 of 4');
  });

  it('says so when the range starts past the end', () => {
    const out = applyListOptions(entries, { range: '9-' });
    if ('error' in out) throw new Error(out.error);
    expect(out.page).toEqual([]);
    expect(out.note).toContain('4 entries');
  });

  it('rejects a malformed range', () => {
    expect(applyListOptions(entries, { range: 'first ten' })).toHaveProperty('error');
  });
});

describe('list on a storage folder', () => {
  let reg: ResourceRegistry;

  beforeAll(async () => {
    reg = initRegistry();
    for (let i = 1; i <= COUNT; i++) {
      const path = `${DIR}/f${String(i).padStart(2, '0')}.txt`;
      await storageWrite(path, 'x'.repeat(i));
      // f01 newest, f12 oldest — the reverse of name order, so the two sorts disagree.
      const when = new Date(Date.UTC(2026, 0, 30 - i));
      await utimes(resolvePath(path)!.absolutePath, when, when);
    }
  });

  it('returns a page and a note with the total when defaultLimit is set', async () => {
    const result = await reg.execute('list', `yaar://storage/${DIR}`, undefined, {
      defaultLimit: 5,
    });
    expect(names(result)).toEqual(['f01.txt', 'f02.txt', 'f03.txt', 'f04.txt', 'f05.txt']);
    expect(note(result)).toContain(`Entries 1-5 of ${COUNT}`);
    expect(note(result)).toContain('range "6-10"');
    expect(result.listFiltered).toBeUndefined();
  });

  it('sorts by size and carries each entry size', async () => {
    const result = await reg.execute('list', `yaar://storage/${DIR}`, undefined, {
      sort: 'size',
      range: '1-3',
    });
    expect(names(result)).toEqual(['f12.txt', 'f11.txt', 'f10.txt']);
  });

  it('sorts by modified and hands back the timestamps it sorted on', async () => {
    const result = await reg.execute('list', `yaar://storage/${DIR}`, undefined, {
      sort: 'modified',
      order: 'asc',
      range: '1-2',
    });
    expect(names(result)).toEqual(['f12.txt', 'f11.txt']);
    const link = result.content.find((b) => b.type === 'resource_link');
    expect(link).toHaveProperty('modifiedAt');
  });

  it('lists the whole folder with no options — the /api/verb door sets no default page', async () => {
    const result = await reg.execute('list', `yaar://storage/${DIR}`);
    expect(names(result)).toHaveLength(COUNT);
    expect(note(result)).toBeUndefined();
  });

  it('pages a read that falls back to list', async () => {
    const result = await reg.execute('read', `yaar://storage/${DIR}`, undefined, {
      defaultLimit: 4,
    });
    expect(names(result)).toHaveLength(4);
  });

  it('notes sort/range as ignored on a resource that does not page', async () => {
    const result = await reg.execute('list', 'yaar://skills', undefined, { range: '1-2' });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain('was ignored');
  });
});

describe("the app agent's storage:list", () => {
  const many = Array.from({ length: LIST_PAGE_SIZE + 5 }, (_, i) =>
    entry(`app/f${String(i).padStart(4, '0')}.txt`, i, 1),
  );
  const structured = (r: VerbResult) =>
    r.structuredContent as { entries: { path: string }[]; _notes?: string[] };

  it('pages at the same default as the verbs door, with the note where a model reads it', () => {
    const out = structured(listAnswer('yaar://apps/x/storage/', { success: true, entries: many }));
    expect(out.entries).toHaveLength(LIST_PAGE_SIZE);
    expect(out._notes?.[0]).toContain(`Entries 1-${LIST_PAGE_SIZE} of ${many.length}`);
  });

  it('takes sort/order/range from the params', () => {
    const options = parseListOptions({ path: 'app', sort: 'size', range: '1-2' });
    if ('error' in options) throw new Error(options.error);
    const out = structured(listAnswer('u', { success: true, entries: many }, options));
    expect(out.entries.map((e) => e.path)).toEqual(['app/f0204.txt', 'app/f0203.txt']);
  });

  it('adds no note to a listing that fits', () => {
    const out = structured(listAnswer('u', { success: true, entries: many.slice(0, 3) }));
    expect(out.entries).toHaveLength(3);
    expect(out._notes).toBeUndefined();
  });

  it('passes a failed listing through untouched', () => {
    const out: VerbResult = listAnswer('u', {
      success: false,
      notFound: true,
      error: 'Directory not found',
    });
    expect(out.structuredContent).toMatchObject({ success: false, error: 'Directory not found' });
  });

  it('refuses a param it cannot mean', () => {
    expect(parseListOptions({ sort: 'date' })).toHaveProperty('error');
    expect(parseListOptions({ order: 'newest' })).toHaveProperty('error');
    expect(parseListOptions({ range: 100 })).toHaveProperty('error');
  });

  it('is the only way a built-in listing leaves the door', () => {
    // A listing answered with a bare `okJson` would come back whole — the regression.
    const src = readFileSync(new URL('../mcp/app-agent/index.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/okJson\(\{\s*uri,\s*\.\.\.(\(await storageList|appRelativeEntries)/);
    expect(src.split('listAnswer(').length - 1).toBeGreaterThanOrEqual(7);
  });
});

describe('a broken symlink in a listed folder', () => {
  const LINKS = 'list-broken-link-fixture';

  beforeAll(async () => {
    await storageWrite(`${LINKS}/real.txt`, 'here');
    const dir = resolvePath(LINKS)!.absolutePath;
    await symlink(`${dir}/no-such-target`, `${dir}/dangling`).catch(() => {});
  });

  it('lists the folder instead of failing it, flagging the link', async () => {
    // One stale link used to throw out of `stat` and fail the whole listing.
    const result = await storageList(LINKS);
    expect(result.success).toBe(true);
    const byName = new Map(result.entries!.map((e) => [e.path, e]));
    expect(byName.get(`${LINKS}/real.txt`)?.brokenLink).toBeUndefined();
    expect(byName.get(`${LINKS}/dangling`)).toMatchObject({ isDirectory: false, brokenLink: true });
  });

  it('says so on the verbs door', async () => {
    const result = await initRegistry().execute('list', `yaar://storage/${LINKS}`);
    const link = result.content.find((b) => b.type === 'resource_link' && b.name === 'dangling');
    expect(link).toMatchObject({ description: 'broken symlink' });
    expect(link).not.toHaveProperty('mimeType');
  });
});
