/**
 * Self cache management (`ENABLE_SELF_CACHE_MANAGEMENT=1`).
 *
 * Two halves, both against a transcript on disk shaped like the CLI's:
 *
 * 1. `context-items.ts` — which items a position names, and what stubbing them leaves.
 * 2. `self-cache.ts` — plan mid-turn, apply through a real `forkSession`. That half is
 *    the one an SDK bump can break without a type error: it relies on a fork keeping
 *    tool_use ids and API message ids while remapping entry uuids.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';

import {
  listContextItems,
  parseTranscript,
  REMOVED_PREFIX,
  serializeTranscript,
  stubContextItems,
} from '../providers/claude/context-items.js';
import {
  applyPendingRemovals,
  forgetAgent,
  hasPendingRemovals,
  noteAgentSession,
  planRemoval,
} from '../providers/claude/self-cache.js';
import { getMonitorTurnOptions, withSelfCacheTool } from '../agents/profiles/turn-options.js';

const BIG = 'x'.repeat(8000);

/** Builds transcript entries the way the CLI chains them: one line per content block. */
class Transcript {
  readonly sessionId = randomUUID();
  private readonly entries: Record<string, unknown>[] = [];
  private parent: string | null = null;

  private push(
    type: string,
    message: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) {
    const uuid = randomUUID();
    this.entries.push({
      parentUuid: this.parent,
      isSidechain: false,
      type,
      message,
      uuid,
      timestamp: new Date().toISOString(),
      userType: 'external',
      cwd: '/work',
      sessionId: this.sessionId,
      version: '0.0.0',
      ...extra,
    });
    this.parent = uuid;
    return this;
  }

  prompt(text: string) {
    return this.push('user', { role: 'user', content: text });
  }

  toolUse(messageId: string, toolUseId: string, name: string, input: Record<string, unknown>) {
    return this.push('assistant', {
      id: messageId,
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name, input }],
    });
  }

  toolResult(toolUseId: string, text: string) {
    return this.push(
      'user',
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] },
        ],
      },
      { toolUseResult: [{ type: 'text', text }], mcpMeta: { structuredContent: { text } } },
    );
  }

  text(messageId: string, text: string) {
    return this.push('assistant', {
      id: messageId,
      role: 'assistant',
      content: [{ type: 'text', text }],
    });
  }

  raw(entry: Record<string, unknown>) {
    this.entries.push(entry);
    return this;
  }

  jsonl(): string {
    return this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  }

  lines() {
    return parseTranscript(this.jsonl());
  }

  /** Put the transcript where the CLI would: under a project dir of the pinned config dir. */
  write(): string {
    const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-work');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${this.sessionId}.jsonl`);
    writeFileSync(path, this.jsonl());
    return path;
  }
}

/** A read, a summary of it, then a second read — the shape the tool is for. */
function readThenSummarise(): Transcript {
  return new Transcript()
    .prompt('look at the two files')
    .toolUse('msg_1', 'toolu_a', 'mcp__verbs__read', { uri: 'yaar://storage/a.txt' })
    .toolResult('toolu_a', BIG)
    .text('msg_2', 'a.txt is a list of rows.')
    .toolUse('msg_2', 'toolu_b', 'mcp__verbs__read', { uri: 'yaar://storage/b.txt' })
    .toolResult('toolu_b', 'short');
}

describe('context items', () => {
  it('lists tool results and assistant text oldest first, labelled by tool and target', () => {
    const items = listContextItems(readThenSummarise().lines());
    expect(items.map((i) => [i.kind, i.label])).toEqual([
      ['tool_result', 'read yaar://storage/a.txt'],
      ['assistant_text', '"a.txt is a list of rows."'],
      ['tool_result', 'read yaar://storage/b.txt'],
    ]);
    expect(items[0].tokens).toBe(2000);
  });

  it('counts nothing from the message making the call, when that message is on disk', () => {
    const t = readThenSummarise()
      .text('msg_3', 'Dropping the first read.')
      .toolUse('msg_3', 'toolu_rc', 'mcp__system__remove_cache', { indices: [-1] });
    const items = listContextItems(t.lines(), { callToolUseId: 'toolu_rc' });
    expect(items.at(-1)?.label).toBe('read yaar://storage/b.txt');
  });

  it('drops a part-written calling message it cannot identify', () => {
    // The text block landed, the tool_use line has not: no id to find, but a transcript
    // never rests on an assistant entry mid-turn.
    const t = readThenSummarise().text('msg_3', 'Dropping the first read.');
    const items = listContextItems(t.lines(), { callToolUseId: 'toolu_not_written_yet' });
    expect(items.at(-1)?.label).toBe('read yaar://storage/b.txt');
  });

  it("leaves the tool's own results and earlier markers out of the count", () => {
    const t = readThenSummarise()
      .toolUse('msg_3', 'toolu_rc', 'mcp__system__remove_cache', {})
      .toolResult('toolu_rc', 'Recent items, newest first: …');
    const lines = t.lines();
    const isOwnTool = (name: string) => name.endsWith('__remove_cache');
    const before = listContextItems(lines, { isOwnTool });
    expect(before).toHaveLength(3);

    stubContextItems(lines, [before[0]]);
    const after = listContextItems(lines, { isOwnTool });
    expect(after.map((i) => i.label)).toEqual([
      '"a.txt is a list of rows."',
      'read yaar://storage/b.txt',
    ]);
  });

  it('offers nothing from before a compaction', () => {
    const t = readThenSummarise()
      .raw({ type: 'system', subtype: 'compact_boundary', uuid: randomUUID() })
      .prompt('summary of the above')
      .toolUse('msg_9', 'toolu_c', 'mcp__verbs__list', { uri: 'yaar://storage/' })
      .toolResult('toolu_c', 'a.txt\nb.txt');
    expect(listContextItems(t.lines()).map((i) => i.label)).toEqual(['list yaar://storage/']);
  });

  it('stubs a tool result in place and keeps the call that asked for it', () => {
    const t = readThenSummarise();
    const lines = t.lines();
    const [first] = listContextItems(lines);
    expect(stubContextItems(lines, [first])).toBe(1);

    const out = serializeTranscript(lines);
    expect(out).not.toContain(BIG);
    expect(out).toContain('"id":"toolu_a"');
    const result = JSON.parse(out.split('\n')[2]);
    expect(result.message.content[0].tool_use_id).toBe('toolu_a');
    expect(result.message.content[0].content[0].text).toStartWith(REMOVED_PREFIX);
    expect(result.message.content[0].content[0].text).toContain('read yaar://storage/a.txt');
    // The CLI's second copies of the result go too, or resume could bring it back.
    expect(result.toolUseResult).toStartWith(REMOVED_PREFIX);
    expect(result.mcpMeta).toBeUndefined();
  });

  it('writes untouched lines back byte for byte, unparseable ones included', () => {
    const source = readThenSummarise().jsonl() + '{"type":"assistant","message":{"id":"msg_4"';
    const lines = parseTranscript(source);
    stubContextItems(lines, [listContextItems(lines)[1]]);
    const before = source.split('\n').filter(Boolean);
    const after = serializeTranscript(lines).split('\n').filter(Boolean);
    expect(after).toHaveLength(before.length);
    const changed = after.flatMap((line, i) => (line === before[i] ? [] : [i]));
    expect(changed).toEqual([3]);
    expect(JSON.parse(after[3]).message.content[0].text).toStartWith(REMOVED_PREFIX);
  });
});

describe('plan and apply', () => {
  const agentId = 'agent-self-cache-test';
  afterEach(() => forgetAgent(agentId));

  it('refuses for an agent with no tracked conversation', async () => {
    const plan = await planRemoval('agent-nobody', [-1], undefined);
    expect(plan.ok).toBe(false);
  });

  it('lists without queueing, then queues by position and reports a miss', async () => {
    const t = readThenSummarise();
    t.write();
    noteAgentSession(agentId, t.sessionId);

    const listing = await planRemoval(agentId, [], undefined);
    if (!listing.ok) throw new Error(listing.reason);
    expect(listing.items.map((i) => [i.index, i.item.label])).toEqual([
      [-1, 'read yaar://storage/b.txt'],
      [-2, '"a.txt is a list of rows."'],
      [-3, 'read yaar://storage/a.txt'],
    ]);
    expect(hasPendingRemovals(agentId)).toBe(false);

    const plan = await planRemoval(agentId, [-3, -9], undefined);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.scheduled.map((i) => i.item.label)).toEqual(['read yaar://storage/a.txt']);
    expect(plan.missing).toEqual([-9]);
    expect(hasPendingRemovals(agentId)).toBe(true);

    // A queued item is no longer a live one, so positions close up behind it.
    const next = await planRemoval(agentId, [], undefined);
    if (!next.ok) throw new Error(next.reason);
    expect(next.items).toHaveLength(2);
    expect(next.pendingCount).toBe(1);
  });

  it('applies to a fork and leaves the original transcript untouched', async () => {
    const t = readThenSummarise();
    const sourcePath = t.write();
    const original = readFileSync(sourcePath, 'utf8');
    noteAgentSession(agentId, t.sessionId);
    await planRemoval(agentId, [-3, -2], undefined);

    const forkId = await applyPendingRemovals(agentId, t.sessionId);
    expect(forkId).toBeString();
    expect(forkId).not.toBe(t.sessionId);
    expect(readFileSync(sourcePath, 'utf8')).toBe(original);
    expect(hasPendingRemovals(agentId)).toBe(false);

    const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-work');
    expect(readdirSync(dir)).toContain(`${forkId}.jsonl`);
    const fork = readFileSync(join(dir, `${forkId}.jsonl`), 'utf8');
    expect(fork).not.toContain(BIG);
    expect(fork).not.toContain('a.txt is a list of rows.');
    expect(fork).toContain('"id":"toolu_a"');
    // The item that was not named survives.
    expect(fork).toContain('"text":"short"');

    // The agent is on the fork now; what was removed is no longer addressable there.
    const after = await planRemoval(agentId, [], undefined);
    if (!after.ok) throw new Error(after.reason);
    expect(after.items.map((i) => i.item.label)).toEqual(['read yaar://storage/b.txt']);
  });

  it('returns null, without forking, when the queue names nothing in the conversation', async () => {
    const planned = readThenSummarise();
    planned.write();
    noteAgentSession(agentId, planned.sessionId);
    await planRemoval(agentId, [-1], undefined);

    const other = new Transcript().prompt('unrelated').text('msg_x', 'nothing here');
    other.write();
    const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-work');
    const before = readdirSync(dir).length;
    expect(await applyPendingRemovals(agentId, other.sessionId)).toBeNull();
    expect(readdirSync(dir)).toHaveLength(before);
    expect(hasPendingRemovals(agentId)).toBe(false);
  });

  it('drops a queue when the agent moves to another conversation', async () => {
    const t = readThenSummarise();
    t.write();
    noteAgentSession(agentId, t.sessionId);
    await planRemoval(agentId, [-1], undefined);
    noteAgentSession(agentId, randomUUID());
    expect(hasPendingRemovals(agentId)).toBe(false);
  });
});

describe('the flag', () => {
  afterEach(() => {
    delete process.env.ENABLE_SELF_CACHE_MANAGEMENT;
  });

  it('offers the tool to Claude monitor and app agents only while it is on', () => {
    expect(getMonitorTurnOptions('claude').allowedTools).not.toContain('mcp__system__remove_cache');
    expect(withSelfCacheTool({ allowedTools: ['mcp__app__query'] }, 'app').allowedTools).toEqual([
      'mcp__app__query',
    ]);

    process.env.ENABLE_SELF_CACHE_MANAGEMENT = '1';
    expect(getMonitorTurnOptions('claude').allowedTools).toContain('mcp__system__remove_cache');
    expect(withSelfCacheTool({ allowedTools: ['mcp__app__query'] }, 'app').allowedTools).toEqual([
      'mcp__app__query',
      'mcp__app__remove_cache',
    ]);
  });

  it('leaves a Codex turn without a tool list', () => {
    process.env.ENABLE_SELF_CACHE_MANAGEMENT = '1';
    expect(getMonitorTurnOptions('codex').allowedTools).toBeUndefined();
  });
});
