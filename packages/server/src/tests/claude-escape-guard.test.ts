/**
 * The three escape-depth failures and the two places they are caught.
 *
 * Every fixture is built programmatically from code points rather than typed as
 * an escape sequence. A test about escape handling whose own source carries the
 * escapes it asserts on is one editor, formatter or copy/paste away from
 * passing for the wrong reason — and writing these by hand is precisely the
 * mistake under test.
 */
import { describe, expect, test } from 'bun:test';
import {
  decodeOverEscaped,
  repairNestedJson,
  repairToolInput,
} from '../providers/claude/escape-repair.js';
import {
  EscapeTripwire,
  escapeGuardNotice,
  isEscapedText,
} from '../providers/claude/escape-tripwire.js';
import { createEscapeRepairHook } from '../providers/claude/escape-hook.js';
import { ESCAPE_SAMPLE_LIMIT, type EscapeGuardRecord } from '../providers/types.js';

/** A literal backslash, never typed as one. */
const BS = String.fromCharCode(92);
/** A real newline, never typed as one. */
const NL = String.fromCharCode(10);

/** The six-character escape *text* for one UTF-16 code unit. */
const esc = (unit: number) => `${BS}u${unit.toString(16).padStart(4, '0')}`;

/** Every code unit of `s` as escape text — surrogate pairs become two escapes. */
const escapeAll = (s: string) =>
  Array.from({ length: s.length }, (_, i) => esc(s.charCodeAt(i))).join('');

/** The doubly-escaped spelling: the same run one level deeper. */
const escapeAllTwice = (s: string) =>
  escapeAll(s)
    .split(BS)
    .join(BS + BS);

// Reference fixtures.
const HANGUL_3 = escapeAll('안녕하'); // three non-ASCII escapes
const HANGUL_2 = escapeAll('안녕'); // two — under the threshold
const ESC_NL = esc(10);
const ESC_QUOTE = esc(34);

/** Raw stream events, shaped as the SDK emits them. */
const startBlock = (index: number, name: string) => ({
  type: 'content_block_start',
  index,
  content_block: { type: 'tool_use', name, id: `tu_${index}` },
});
const delta = (index: number, partial_json: string) => ({
  type: 'content_block_delta',
  index,
  delta: { type: 'input_json_delta', partial_json },
});

describe('isEscapedText', () => {
  test('trips on three consecutive non-ASCII escapes', () => {
    expect(isEscapedText(`{"text":"${HANGUL_3}`)).toBe(true);
  });

  test('trips on the double-escaped spelling too', () => {
    expect(isEscapedText(`{"text":"${escapeAllTwice('안녕하')}`)).toBe(true);
  });

  test('ignores ASCII escapes — genuine source code is not the bug', () => {
    expect(isEscapedText(`{"content":"${escapeAll('ABCD')}"}`)).toBe(false);
  });

  test('ignores escaped newlines and quotes on their own', () => {
    expect(isEscapedText(`{"content":"${ESC_NL}${ESC_QUOTE}${ESC_NL}${ESC_QUOTE}"}`)).toBe(false);
  });

  test('still trips when a run is diluted by escaped newlines', () => {
    // Escaped CJK prose carries its own line breaks; an ASCII escape between
    // non-ASCII ones must not reset the count.
    const diluted = esc(0xc548) + ESC_NL + esc(0xb155) + ESC_NL + esc(0xd558);
    expect(isEscapedText(diluted)).toBe(true);
  });

  test('two non-ASCII escapes are under the threshold', () => {
    expect(isEscapedText(`{"text":"${HANGUL_2}"}`)).toBe(false);
  });

  test('a plain JSON fragment with no escapes does not trip', () => {
    expect(isEscapedText('{"content":"안녕하세요, 반갑습니다"}')).toBe(false);
  });
});

describe('EscapeTripwire', () => {
  test('trips mid-stream on a watched tool', () => {
    const wire = new EscapeTripwire();
    expect(wire.observe(startBlock(0, 'Write'))).toBeNull();
    expect(wire.observe(delta(0, '{"content":"'))).toBeNull();
    expect(wire.observe(delta(0, HANGUL_3))?.toolName).toBe('Write');
  });

  test('reassembles an escape split across two deltas', () => {
    const wire = new EscapeTripwire();
    wire.observe(startBlock(0, 'Write'));
    const split = HANGUL_3.slice(0, -2);
    expect(wire.observe(delta(0, `{"content":"${split}`))).toBeNull();
    expect(wire.observe(delta(0, HANGUL_3.slice(-2)))?.toolName).toBe('Write');
  });

  test('ignores tools outside the watched set', () => {
    const wire = new EscapeTripwire();
    wire.observe(startBlock(0, 'Bash'));
    expect(wire.observe(delta(0, HANGUL_3))).toBeNull();
  });

  test('ignores deltas for a block it never saw start', () => {
    const wire = new EscapeTripwire();
    expect(wire.observe(delta(7, HANGUL_3))).toBeNull();
  });

  test('trips only once per content block', () => {
    const wire = new EscapeTripwire();
    wire.observe(startBlock(0, 'Write'));
    expect(wire.observe(delta(0, HANGUL_3))?.toolName).toBe('Write');
    expect(wire.observe(delta(0, HANGUL_3))).toBeNull();
  });

  test('tracks concurrent blocks independently', () => {
    const wire = new EscapeTripwire();
    wire.observe(startBlock(0, 'Write'));
    wire.observe(startBlock(1, 'Edit'));
    expect(wire.observe(delta(0, '{"content":"plain text"'))).toBeNull();
    expect(wire.observe(delta(1, HANGUL_3))?.toolName).toBe('Edit');
  });

  test('reset drops block state', () => {
    const wire = new EscapeTripwire();
    wire.observe(startBlock(0, 'Write'));
    wire.reset();
    expect(wire.observe(delta(0, HANGUL_3))).toBeNull();
  });
});

describe('decodeOverEscaped', () => {
  test('decodes a literal escape run that yields non-ASCII', () => {
    expect(decodeOverEscaped(HANGUL_2)).toBe('안녕');
  });

  test('leaves ASCII escape runs alone', () => {
    const src = `const a = "${escapeAll('AB')}";`;
    expect(decodeOverEscaped(src)).toBe(src);
  });

  test('reassembles a surrogate pair into one code point', () => {
    const decoded = decodeOverEscaped(escapeAll('\u{1F600}'));
    expect(decoded).toBe('\u{1F600}');
    expect([...decoded]).toHaveLength(1);
  });

  test('leaves text with no escapes untouched', () => {
    expect(decodeOverEscaped('안녕하세요')).toBe('안녕하세요');
  });

  test('decodes a run embedded in surrounding prose', () => {
    expect(decodeOverEscaped(`greeting: ${HANGUL_2}!`)).toBe('greeting: 안녕!');
  });
});

describe('repairNestedJson', () => {
  test('re-escapes a raw newline inside a nested JSON string', () => {
    const broken = `{"body":"line one${NL}line two"}`;
    const fixed = repairNestedJson(broken);
    expect(fixed).not.toBeNull();
    expect(JSON.parse(fixed!)).toEqual({ body: `line one${NL}line two` });
  });

  test('leaves already-valid JSON alone', () => {
    expect(repairNestedJson('{"body":"fine"}')).toBeNull();
  });

  test('leaves legal whitespace between tokens alone', () => {
    expect(repairNestedJson(`{${NL}  "a": 1${NL}}`)).toBeNull();
  });

  test('refuses to touch JSON broken for some other reason', () => {
    expect(repairNestedJson('{"a": }')).toBeNull();
    expect(repairNestedJson('{"unterminated": "x')).toBeNull();
  });

  test('is not fooled by an escaped quote before the raw newline', () => {
    const broken = `{"body":"she said ${BS}"hi${BS}"${NL}then left"}`;
    const fixed = repairNestedJson(broken);
    expect(fixed).not.toBeNull();
    expect(JSON.parse(fixed!)).toEqual({ body: `she said "hi"${NL}then left` });
  });

  test('ignores strings that are not JSON at all', () => {
    expect(repairNestedJson(`just prose${NL}with a newline`)).toBeNull();
  });

  test('repairs an array payload too', () => {
    const fixed = repairNestedJson(`[{"a":"x${NL}y"}]`);
    expect(fixed).not.toBeNull();
    expect(JSON.parse(fixed!)).toEqual([{ a: `x${NL}y` }]);
  });
});

describe('repairToolInput', () => {
  test('reports the path of an over-escaped value', () => {
    const { value, overEscaped } = repairToolInput({
      file_path: '/tmp/a.txt',
      content: HANGUL_2,
    });
    expect(overEscaped).toEqual(['content']);
    expect((value as { content: string }).content).toBe('안녕');
  });

  test('reports the path of an under-escaped nested payload', () => {
    const { value, underEscaped } = repairToolInput({
      payload: `{"body":"one${NL}two"}`,
    });
    expect(underEscaped).toEqual(['payload']);
    expect(() => JSON.parse((value as { payload: string }).payload)).not.toThrow();
  });

  test('walks nested objects and arrays, naming dotted paths', () => {
    const { overEscaped } = repairToolInput({
      components: [{ text: 'plain' }, { text: HANGUL_2 }],
    });
    expect(overEscaped).toEqual(['components[1].text']);
  });

  test('reports nothing for clean input, and returns it unchanged', () => {
    const input = { file_path: '/tmp/a.txt', content: '안녕하세요' };
    const { value, overEscaped, underEscaped } = repairToolInput(input);
    expect(overEscaped).toEqual([]);
    expect(underEscaped).toEqual([]);
    expect(value).toEqual(input);
  });

  test('preserves non-string leaves', () => {
    const input = { n: 1, b: true, nul: null, arr: [1, 2] };
    expect(repairToolInput(input).value).toEqual(input);
  });
});

describe('escape guard records', () => {
  test('a trip carries the raw JSON that triggered it', () => {
    const wire = new EscapeTripwire();
    wire.observe(startBlock(0, 'Write'));
    const record = wire.observe(delta(0, `{"content":"${HANGUL_3}`));
    expect(record).not.toBeNull();
    expect(record!.stage).toBe('tripwire');
    expect(record!.toolName).toBe('Write');
    // The evidence is the spelling: the sample must hold escape *text*, not
    // the characters those escapes stand for.
    expect(record!.sample).toContain(HANGUL_3);
    expect(record!.sample).not.toContain('안녕하');
  });

  test('a trip sample is bounded by the detector tail, not the whole argument', () => {
    // The tail window is smaller than ESCAPE_SAMPLE_LIMIT, so a tripwire sample
    // is already bounded before truncation ever applies — an escaped document
    // cannot put its whole length in the log.
    const wire = new EscapeTripwire();
    wire.observe(startBlock(0, 'Write'));
    const record = wire.observe(delta(0, escapeAll('안'.repeat(500))));
    expect(record).not.toBeNull();
    expect(record!.sample.length).toBeLessThanOrEqual(ESCAPE_SAMPLE_LIMIT);
  });

  test('a long repaired value is truncated, with the full length noted', async () => {
    const seen: EscapeGuardRecord[] = [];
    const hook = createEscapeRepairHook((r) => seen.push(r));
    await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { content: escapeAll('안'.repeat(200)) },
        tool_use_id: 'tu_3',
        session_id: 's',
        transcript_path: '',
        cwd: '',
        permission_mode: 'bypassPermissions',
      } as Parameters<typeof hook>[0],
      'tu_3',
      { signal: new AbortController().signal },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].sample).toContain('chars)');
    expect(seen[0].sample.length).toBeLessThan(ESCAPE_SAMPLE_LIMIT + 40);
  });

  test('the notice is non-terminal and carries the record for the logger', () => {
    const record: EscapeGuardRecord = { stage: 'tripwire', toolName: 'Write', sample: 'x' };
    const notice = escapeGuardNotice(record);
    expect(notice.type).toBe('notice');
    expect(notice.escapeGuard).toBe(record);
    expect(notice.errorCode).toBe('escape_guard_tripwire');
  });

  test('the repair hook reports what it fixed, with the pre-repair text', async () => {
    const seen: EscapeGuardRecord[] = [];
    const hook = createEscapeRepairHook((r) => seen.push(r));

    const result = await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/tmp/a.txt', content: HANGUL_2 },
        tool_use_id: 'tu_1',
        session_id: 's',
        transcript_path: '',
        cwd: '',
        permission_mode: 'bypassPermissions',
      } as Parameters<typeof hook>[0],
      'tu_1',
      { signal: new AbortController().signal },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].stage).toBe('repair');
    expect(seen[0].overEscaped).toEqual(['content']);
    expect(seen[0].sample).toBe(HANGUL_2);
    // …and the call still runs, with the repaired arguments.
    const output = result as { hookSpecificOutput?: { updatedInput?: { content?: string } } };
    expect(output.hookSpecificOutput?.updatedInput?.content).toBe('안녕');
  });

  test('the repair hook stays silent on clean input', async () => {
    const seen: EscapeGuardRecord[] = [];
    const hook = createEscapeRepairHook((r) => seen.push(r));
    const result = await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { content: '안녕하세요' },
        tool_use_id: 'tu_2',
        session_id: 's',
        transcript_path: '',
        cwd: '',
        permission_mode: 'bypassPermissions',
      } as Parameters<typeof hook>[0],
      'tu_2',
      { signal: new AbortController().signal },
    );
    expect(seen).toEqual([]);
    expect(result).toEqual({});
  });
});
