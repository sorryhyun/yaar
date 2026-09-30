/**
 * Two sessions created in the same second get two log directories.
 *
 * The directory name has second resolution. It used to be claimed with a recursive
 * mkdir, which accepts a directory that already exists, and the writes after it then
 * truncated the other session's transcript and overwrote its metadata.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../logging/session-logger.js';

const dir = mkdtempSync(join(tmpdir(), 'yaar-session-collision-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('createSession', () => {
  it('never reuses a directory another session holds', async () => {
    const first = await createSession('claude', dir);
    appendFileSync(join(first.directory, 'messages.jsonl'), '{"kept":true}\n');

    const second = await createSession('codex', dir);
    const third = await createSession('codex', dir);

    expect(new Set([first.directory, second.directory, third.directory]).size).toBe(3);
    expect(readFileSync(join(first.directory, 'messages.jsonl'), 'utf8')).toBe('{"kept":true}\n');
    const metadata = JSON.parse(readFileSync(join(first.directory, 'metadata.json'), 'utf8'));
    expect(metadata.provider).toBe('claude');
  });
});
