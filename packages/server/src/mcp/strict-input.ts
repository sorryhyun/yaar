/**
 * Tool input that refuses an argument it does not declare, and names it.
 *
 * A raw shape handed to `registerTool` is wrapped in a plain `z.object`, which *strips*
 * unknown keys: the call runs as if the key had never been sent. That is the worst
 * answer for a key the caller meant — `command({ command: 'extrude', params: {...},
 * expectVersion })` ran the extrude with its stale-id guard silently off, because
 * `expectVersion` belonged inside `params` and nothing said so. One level down, the
 * app protocol already names an unknown param; this is the same rigor at the tool
 * boundary, with the fix spelled out when the tool has a bag the key should go in.
 *
 * The strictness also reaches the listing (`additionalProperties: false`), so a model
 * reading the schema is told up front, not only after a failed call.
 */
import { z } from 'zod';

export function strictInput<S extends z.ZodRawShape>(shape: S, opts: { nestUnder?: string } = {}) {
  const declared = Object.keys(shape);
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code !== 'unrecognized_keys') return undefined;
      const keys = issue.keys;
      const quoted = keys.map((k) => `"${k}"`).join(', ');
      const hint = opts.nestUnder
        ? ` If ${keys.length > 1 ? 'they are' : 'it is'} meant for the target, pass ` +
          `${keys.map((k) => `${opts.nestUnder}.${k}`).join(', ')} instead.`
        : '';
      return (
        `unknown argument${keys.length > 1 ? 's' : ''} ${quoted} - this tool takes ` +
        `${declared.join(', ')}.${hint}`
      );
    },
  });
}
