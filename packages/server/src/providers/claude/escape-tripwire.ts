/**
 * Mid-stream detector for tool arguments being written as `\uXXXX` escapes.
 *
 * The repairs in `escape-repair.ts` run on the *parsed* tool input, which is
 * the only place double-escaping is visible but also too late to be cheap: by
 * then the arguments are fully generated. Plain over-escaping is invisible
 * there entirely — `안녕` has already decoded to `안녕`, so the parsed
 * input looks perfect no matter how wastefully it arrived.
 *
 * The raw JSON the model is generating *is* visible, one delta at a time, on
 * `content_block_delta` / `input_json_delta.partial_json` (YAAR already runs
 * with `includePartialMessages: true`). Watching it lets a turn be cancelled
 * while the escaping is still in its first few characters.
 *
 * Why that is worth a cancelled turn: escaped CJK costs roughly six tokens per
 * character, so a long document written this way routinely runs into the output
 * limit *mid-escape*. The JSON is then unterminated, the tool call fails, and
 * the whole generation is lost anyway. Tripping at the third escape trades a
 * short prefix for a doomed completion. For a short string it is a net loss,
 * which is why the tripwire is scoped to the tools whose arguments get large.
 *
 * @see providers/claude/escape-repair.ts — the parsed-input repairs.
 */

import { escapeSample, type EscapeGuardRecord, type StreamMessage } from '../types.js';

/**
 * Three or more consecutive escapes. `\\{1,2}` also catches the double-escaped
 * spelling (`\\uc548`), which is the same mistake one level deeper.
 */
const ESCAPE_RUN = /(?:\\{1,2}u[0-9A-Fa-f]{4}){3,}/;

/**
 * How much of each block's raw JSON to keep.
 *
 * Three escapes is 18 characters, but a run is routinely *diluted*: escaped
 * prose carries its own newlines and quotes, which the model escapes too, so
 * the escaped forms of U+000A and U+0022 sit inside the run. Those neither trip
 * the wire nor break it, so the
 * buffer has to be long enough to still hold three non-ASCII escapes once the
 * ASCII ones are interleaved — plus slack for a delta that splits an escape
 * across two frames (`\u4f` then `60`).
 */
const TAIL = 256;

/** Minimum non-ASCII escapes in one run before the wire trips. */
const THRESHOLD = 3;

/**
 * Whether a raw-JSON fragment carries a run of escapes that are mostly text.
 *
 * The non-ASCII test is what keeps genuine source code out of it: an agent
 * writing the escaped form of U+0041 or U+000A into a file means those exact
 * characters, and a
 * detector that fired on them would trip on every JSON-in-JSON payload YAAR
 * moves. Only escapes that decode above ASCII count toward the threshold; the
 * ASCII ones are skipped without resetting the run.
 */
export function isEscapedText(fragment: string): boolean {
  const match = ESCAPE_RUN.exec(fragment);
  if (!match) return false;
  let nonAscii = 0;
  for (const m of match[0].matchAll(/u([0-9A-Fa-f]{4})/g)) {
    if (parseInt(m[1], 16) > 0x7f) nonAscii++;
  }
  return nonAscii >= THRESHOLD;
}

/**
 * Tools whose arguments are large enough that a cancelled turn beats a doomed
 * one. A short `describe` call escaping three characters is not worth the
 * restart, and the parsed-input repair covers it anyway.
 */
const WATCHED_TOOLS = /^(Write|Edit|NotebookEdit|mcp__verbs__(invoke|read))$/;

/** One turn's worth of per-content-block state. Not reusable across turns. */
export class EscapeTripwire {
  private tails = new Map<number, string>();
  private names = new Map<number, string>();

  /**
   * Feed one raw SDK stream event.
   *
   * @returns a record naming the tool and carrying the raw argument JSON that
   * tripped it, else `null`. Trips at most once per content block — the block's
   * buffer is dropped on the way out, so a caller that ignores the trip is not
   * told again for the same arguments.
   */
  observe(event: unknown): EscapeGuardRecord | null {
    if (!event || typeof event !== 'object') return null;
    const e = event as {
      type?: string;
      index?: number;
      delta?: { type?: string; partial_json?: string };
      content_block?: { type?: string; name?: string };
    };
    const index = e.index ?? 0;

    if (e.type === 'content_block_start') {
      const block = e.content_block;
      if (block?.type === 'tool_use' && block.name && WATCHED_TOOLS.test(block.name)) {
        this.names.set(index, block.name);
        this.tails.set(index, '');
      }
      return null;
    }

    if (e.type === 'content_block_stop') {
      this.tails.delete(index);
      this.names.delete(index);
      return null;
    }

    if (e.type !== 'content_block_delta' || e.delta?.type !== 'input_json_delta') return null;

    const prev = this.tails.get(index);
    if (prev === undefined) return null; // not a watched tool_use block
    const buffer = (prev + (e.delta.partial_json ?? '')).slice(-TAIL);
    this.tails.set(index, buffer);

    if (!isEscapedText(buffer)) return null;
    const toolName = this.names.get(index) ?? 'unknown';
    this.tails.delete(index);
    this.names.delete(index);
    // `buffer`, not the delta: the tail is what the detector actually matched,
    // and a single delta is often a fragment too short to read as evidence.
    return { stage: 'tripwire', toolName, sample: escapeSample(buffer) };
  }

  /** Drop all block state — call between turns on a reused stream. */
  reset(): void {
    this.tails.clear();
    this.names.clear();
  }
}

/**
 * The `notice` carrying an escape-guard record onto the message stream.
 *
 * A notice rather than an `error`: nothing about either guard ends the turn —
 * the tripwire restarts it and the repair lets the call through — and `error`
 * is terminal by contract. `StreamToEventMapper`'s notice branch is what
 * persists the record; see `EscapeGuardRecord`.
 */
export function escapeGuardNotice(record: EscapeGuardRecord): StreamMessage {
  const text =
    record.stage === 'tripwire'
      ? `Cancelled a ${record.toolName} call whose arguments were being written as \\uXXXX escape sequences; retrying.`
      : `Repaired escape sequences in a ${record.toolName} call before running it.`;
  return {
    type: 'notice',
    content: text,
    noticeLevel: 'warning',
    errorCode: `escape_guard_${record.stage}`,
    escapeGuard: record,
  };
}

/** The correction pushed to the model after a trip. */
export function escapeCorrection(toolName: string): string {
  return (
    `Your \`${toolName}\` call was cancelled: its arguments were being written as ` +
    `\\uXXXX escape sequences instead of characters. Retry the call writing the text ` +
    `natively (안녕, not \\uc548\\ub155). If a parameter takes JSON as a string, escape ` +
    `it once for that string (\\\\n inside it, not \\n).`
  );
}
