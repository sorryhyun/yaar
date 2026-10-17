import { describe, expect, it } from 'bun:test';
import { getCliRestoreEntries } from '../logging/cli-restore.js';
import type { ParsedMessage } from '../logging/types.js';

function message(agentId: string, content: string): ParsedMessage {
  return {
    type: 'user',
    timestamp: '2026-10-17T00:00:00.000Z',
    agentId,
    parentAgentId: null,
    content,
  };
}

describe('getCliRestoreEntries', () => {
  // A monitor turn's messages are logged under `monitorTurnRole` — the monitor id with the
  // message id after it — so a match on the bare "monitor-0" restored nothing at all.
  it('keeps messages logged under a monitor turn role', () => {
    const entries = getCliRestoreEntries([
      message('monitor-1-msg-1790998277203-qmh9n', 'hi'),
      message('monitor-0', 'bare'),
    ]);
    expect(entries.map((e) => [e.monitorId, e.content])).toEqual([
      ['1', 'hi'],
      ['0', 'bare'],
    ]);
  });

  it('skips app and ephemeral agents', () => {
    const entries = getCliRestoreEntries([
      message('app-memo-m0-msg-1', 'app'),
      message('ephemeral-0-msg-2', 'eph'),
    ]);
    expect(entries).toEqual([]);
  });
});
