/**
 * Mid-stream detector for tool arguments being written as `\uXXXX` escapes.
 *
 * The repairs in `escape-repair.ts` run on the *parsed* tool input, which is
 * the only place double-escaping is visible but also too late to be cheap: by
 * then the arguments are fully generated. Plain over-escaping is invisible
 * there entirely — `\uc548\ub155` has already decoded to `안녕`, so the parsed
 * input looks perfect no matter how wastefully it arrived, and no matter
 * whether the codepoints the model typed were the ones it meant.
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
 *
 * Backslash parity on the raw wire, for `n` backslashes before a `u`: odd `n`
 * ends in a live JSON escape (the character itself was escaped), `n = 2` is the
 * double-escaped form, and `n = 4` is an escaped backslash followed by the
 * literal text `uXXXX` — not an escape at either level. This needs no parity
 * guard of its own: each element must begin right where the previous one's hex
 * digits end, so a run of `n = 4` elements never chains into a match, and only
 * the *first* element of a run can sit behind extra backslashes. That bounds
 * the misread to one escape at the head of a run that already holds two real
 * ones — and `n = 4` is also how a double escape inside a JSON-in-a-string
 * parameter is spelled, so it is not clearly wrong to count it either.
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
 * How much of each block's raw JSON to keep from the *start*, for naming the
 * call. The tail above slides past the opening keys long before a document
 * trips, and the opening keys are where the target usually sits.
 */
const HEAD = 512;

/**
 * The arguments that say what a watched call was aimed at, most specific first.
 * A tool name alone does not: nearly every monitor call is `mcp__verbs__invoke`,
 * so a correction naming only the tool reads as cancelling whichever invoke the
 * model remembers last — in practice a message it had already sent, which it
 * then sent again. Read off the raw head here and off the parsed input by
 * `callTargets`.
 */
const TARGET_KEYS = ['uri', 'file_path', 'notebook_path'] as const;

/** A raw-JSON `"<key>": "<value>"` pair for any of `keys`, capturing an unescaped value. */
function rawKeyPattern(keys: readonly string[]): RegExp {
  return new RegExp(`"(?:${keys.join('|')})"\\s*:\\s*"([^"\\\\]{1,200})"`);
}

/**
 * The first of `TARGET_KEYS` written in the raw head — first by position, not by
 * the list's order: the head is a prefix of JSON, read as it arrived.
 */
const TARGET_KEY = rawKeyPattern(TARGET_KEYS);

/**
 * The fallback when none of those is written: an app command names its file in
 * `params.path`. A bare `"path"` key is only read when nothing better is there,
 * since the raw head is a prefix of JSON and the key's nesting cannot be checked.
 */
const PATH_KEY = rawKeyPattern(['path']);

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
 *
 * `mcp__app__command` is an app agent's write path — Dev Tools' `files/write`
 * and `files/edit` carry whole files in `params`. The CLI's own Write/Edit/
 * NotebookEdit are not listed: `sdk-options.ts` never enables them. (`query`
 * carries only a state key, so it is not worth a cancelled turn.)
 */
const WATCHED_TOOLS = /^mcp__(verbs__(invoke|read)|app__command)$/;

/** One turn's worth of per-content-block state. Not reusable across turns. */
export class EscapeTripwire {
  private tails = new Map<number, string>();
  private heads = new Map<number, string>();
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
        this.heads.set(index, '');
      }
      return null;
    }

    if (e.type === 'content_block_stop') {
      this.forget(index);
      return null;
    }

    if (e.type !== 'content_block_delta' || e.delta?.type !== 'input_json_delta') return null;

    const prev = this.tails.get(index);
    if (prev === undefined) return null; // not a watched tool_use block
    const fragment = e.delta.partial_json ?? '';
    const buffer = (prev + fragment).slice(-TAIL);
    this.tails.set(index, buffer);
    const sofar = this.heads.get(index) ?? '';
    if (sofar.length < HEAD) this.heads.set(index, (sofar + fragment).slice(0, HEAD));

    if (!isEscapedText(buffer)) return null;
    const toolName = this.names.get(index) ?? 'unknown';
    const head = this.heads.get(index) ?? '';
    const target = (TARGET_KEY.exec(head) ?? PATH_KEY.exec(head))?.[1];
    this.forget(index);
    // `buffer`, not the delta: the tail is what the detector actually matched,
    // and a single delta is often a fragment too short to read as evidence.
    const record: EscapeGuardRecord = { stage: 'tripwire', toolName, sample: escapeSample(buffer) };
    if (target) record.target = target;
    return record;
  }

  /** Drop all block state — call between turns on a reused stream. */
  reset(): void {
    this.tails.clear();
    this.heads.clear();
    this.names.clear();
  }

  private forget(index: number): void {
    this.tails.delete(index);
    this.heads.delete(index);
    this.names.delete(index);
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
  const call = record.target
    ? `${record.toolName} call on ${record.target}`
    : `${record.toolName} call`;
  const text =
    record.stage === 'tripwire'
      ? `Cancelled a ${call} whose arguments were being written as \\uXXXX escape sequences; retrying.`
      : `Repaired escape sequences in a ${record.toolName} call before running it.`;
  return {
    type: 'notice',
    content: text,
    noticeLevel: 'warning',
    errorCode: `escape_guard_${record.stage}`,
    escapeGuard: record,
  };
}

/** A call the trip's interrupt cut off: issued, still waiting on its result. */
export interface CutOffCall {
  toolName: string;
  target?: string;
}

/**
 * Every target a parsed tool input names, most specific first: `uri`,
 * `file_path`, `notebook_path`, then an app command's `params.path`.
 */
export function callTargets(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const record = input as Record<string, unknown>;
  const params = record.params;
  const values = [
    ...TARGET_KEYS.map((key) => record[key]),
    params && typeof params === 'object' ? (params as Record<string, unknown>).path : undefined,
  ];
  return values.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** The same target a trip is named by, read off a parsed tool input. */
export function callTarget(input: unknown): string | undefined {
  return callTargets(input)[0]?.slice(0, 200);
}

function describeCall(call: CutOffCall): string {
  return call.target
    ? `\`${call.toolName}\` call on \`${call.target}\``
    : `\`${call.toolName}\` call`;
}

/**
 * The correction pushed to the model after a trip.
 *
 * It names the cancelled call by its target and says outright that nothing
 * else was undone: the model sees an interrupt land after calls that already
 * returned results, and without both it guesses which call died — and redoes
 * one that had succeeded.
 *
 * The interrupt also cuts off every call still waiting on its result
 * (`cutOff`), and the CLI answers each with "The user doesn't want to
 * proceed…". Unexplained, the model takes that as the user rejecting the call
 * and stops — and tells the user they rejected it — while the call's side
 * effects carry on and land anyway. So the correction always disowns that
 * wording, and names the cut-off calls with an instruction to check before
 * redoing them.
 */
export function escapeCorrection(
  record: Pick<EscapeGuardRecord, 'toolName' | 'target'>,
  cutOff: readonly CutOffCall[] = [],
): string {
  const lines = [
    `Your ${describeCall(record)} was cancelled before it ran: its arguments were being ` +
      `written as \\uXXXX escape sequences instead of characters.`,
  ];
  if (cutOff.length === 0) {
    lines.push(
      `Only that call was cancelled — every call that already returned a result this turn ` +
        `ran normally, so do not repeat those.`,
    );
  } else {
    const [that, it] = cutOff.length === 1 ? ['That call', 'it'] : ['Those calls', 'them'];
    lines.push(
      `Cancelling it also cut off ${cutOff.map(describeCall).join(', ')}, which had not ` +
        `returned yet. ${that} may already have run, or still be running — check whether ` +
        `what ${it} produced exists before repeating ${it}; do not assume nothing ` +
        `happened. Every call that already returned a result this turn ran normally, so do ` +
        `not repeat those.`,
    );
  }
  lines.push(
    `Any "The user doesn't want to proceed with this tool use" result you see from this ` +
      `cancellation came from YAAR, not the user — nobody rejected anything, so do not stop ` +
      `or tell the user they rejected it.`,
    `Retry the cancelled call, writing the text natively (안녕, not \\uc548\\ub155). If a ` +
      `parameter takes JSON as a string, escape it once for that string (\\\\n inside it, ` +
      `not \\n).`,
  );
  return lines.join(' ');
}
