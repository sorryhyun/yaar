/**
 * Codex command-output streaming — the live tail of a running command.
 *
 * `item/commandExecution/outputDelta` used to sit in the ignored list, so a
 * command that took a minute was a minute of silence broken only by its
 * finished result. These tests pin the wiring that replaced that: deltas map to
 * `tool_output_delta` in arrival order, and the authoritative `tool_result`
 * still lands afterwards carrying the aggregated output, so the tail is
 * additive rather than a replacement for it.
 *
 * The two must also agree on `toolUseId` — that id is what pairs a call's
 * output with its result downstream (and what releases the per-call tail
 * budget in `StreamToEventMapper`).
 */
import { describe, it, expect } from 'bun:test';
import { mapNotification } from '../providers/codex/message-mapper.js';

const ITEM = { threadId: 't1', turnId: 'turn1', itemId: 'item-7' };

describe('codex command output deltas', () => {
  it('maps an output delta to a tool_output_delta carrying the chunk', () => {
    const msg = mapNotification('item/commandExecution/outputDelta', {
      ...ITEM,
      delta: 'compiling...\n',
    });

    expect(msg).toEqual({
      type: 'tool_output_delta',
      toolName: 'command',
      toolUseId: 'item-7',
      content: 'compiling...\n',
    });
  });

  it('preserves chunk order, so appending reconstructs the output', () => {
    const chunks = ['one\n', 'two\n', 'three\n'];
    const mapped = chunks.map((delta) =>
      mapNotification('item/commandExecution/outputDelta', { ...ITEM, delta }),
    );

    expect(mapped.map((m) => m?.content).join('')).toBe('one\ntwo\nthree\n');
  });

  it('skips an empty delta rather than emitting a contentless frame', () => {
    expect(mapNotification('item/commandExecution/outputDelta', { ...ITEM, delta: '' })).toBeNull();
  });

  it('still delivers the whole output on completion, tagged with the same id', () => {
    const started = mapNotification('item/commandExecution/started', {
      type: 'commandExecution',
      id: 'item-7',
      command: 'make build',
    });
    const completed = mapNotification('item/commandExecution/completed', {
      type: 'commandExecution',
      id: 'item-7',
      command: 'make build',
      aggregatedOutput: 'one\ntwo\nthree\n',
      exitCode: 0,
    });

    expect(started).toMatchObject({ type: 'tool_use', toolName: 'command', toolUseId: 'item-7' });
    expect(completed).toMatchObject({ type: 'tool_result', toolUseId: 'item-7' });
    // The result is authoritative and complete — the deltas did not consume it.
    expect((completed as { content: string }).content).toContain('one\ntwo\nthree\n');
  });
});
