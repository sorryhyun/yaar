/**
 * `PreToolUse` hook that repairs escape-depth mistakes in tool arguments.
 *
 * Repairs rather than denies. A denial costs a full retry and the model has no
 * more information the second time than it had the first; both failures in
 * `escape-repair.ts` have a single correct rewrite that can be computed here,
 * so the call proceeds with fixed arguments and `additionalContext` tells the
 * model what changed. `updatedInput` is the SDK's channel for exactly this.
 *
 * Note what this hook structurally *cannot* see: `PreToolUseHookInput.tool_input`
 * is the already-JSON-parsed object, so wire-level over-escaping has decoded to
 * correct characters before the hook runs and is invisible here by construction.
 * That case belongs to `escape-tripwire.ts`, which reads the raw stream.
 *
 * The hook is built per turn rather than exported as a singleton so it can be
 * handed a sink: it runs inside an SDK callback with no route to the session
 * logger, and a repair that leaves no record is a model defect nobody can
 * report afterwards. The provider drains the sink into the message stream,
 * which is where the logger is.
 */

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { repairToolInput } from './escape-repair.js';
import { escapeSample, type EscapeGuardRecord } from '../types.js';

/** Human-readable summary of a repair, fed back to the model as context. */
function describeRepair(overEscaped: string[], underEscaped: string[]): string {
  const parts: string[] = [];
  if (overEscaped.length > 0) {
    parts.push(
      `decoded literal \\uXXXX escape sequences in ${overEscaped.join(', ')} ` +
        `— write those characters natively`,
    );
  }
  if (underEscaped.length > 0) {
    parts.push(
      `re-escaped raw control characters inside the JSON string in ${underEscaped.join(', ')} ` +
        `— a JSON value carried as a string needs its newlines escaped for that string too`,
    );
  }
  return `YAAR repaired this tool input before running it: ${parts.join('; ')}.`;
}

/**
 * The offending text, taken from the first repaired path.
 *
 * The *pre-repair* value, since the point of the record is what the model
 * wrote. One path is enough: a call that mangled several fields mangled them
 * all the same way, and the log entry names every path regardless.
 */
function sampleFrom(input: unknown, paths: string[]): string {
  const first = paths[0];
  if (!first) return '';
  let cursor: unknown = input;
  for (const step of first.split('.')) {
    const match = /^([^[]*)((?:\[\d+\])*)$/.exec(step);
    if (!match) return '';
    if (match[1] && cursor && typeof cursor === 'object') {
      cursor = (cursor as Record<string, unknown>)[match[1]];
    }
    for (const idx of match[2].matchAll(/\[(\d+)\]/g)) {
      if (!Array.isArray(cursor)) return '';
      cursor = cursor[Number(idx[1])];
    }
  }
  return typeof cursor === 'string' ? escapeSample(cursor) : '';
}

/**
 * Build the repair hook for one turn.
 *
 * @param onRepair called with the record whenever a repair actually happened.
 * Never called for clean input, which is the overwhelmingly common case — the
 * walk is a few string comparisons over an already-parsed object, cheap enough
 * to run on every tool call.
 */
export function createEscapeRepairHook(
  onRepair: (record: EscapeGuardRecord) => void,
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};

    const { value, overEscaped, underEscaped } = repairToolInput(input.tool_input);
    if (overEscaped.length === 0 && underEscaped.length === 0) return {};

    const summary = describeRepair(overEscaped, underEscaped);
    console.warn(`[claude:escape-repair] ${input.tool_name}: ${summary}`);
    onRepair({
      stage: 'repair',
      toolName: input.tool_name,
      sample: sampleFrom(input.tool_input, [...overEscaped, ...underEscaped]),
      ...(overEscaped.length > 0 ? { overEscaped } : {}),
      ...(underEscaped.length > 0 ? { underEscaped } : {}),
    });

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: value as Record<string, unknown>,
        additionalContext: summary,
      },
    };
  };
}
