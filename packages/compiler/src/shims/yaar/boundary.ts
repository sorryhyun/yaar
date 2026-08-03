// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * Validating data that came from outside the app.
 *
 * Persisted JSON and HTTP responses are untrusted input, both for the same
 * reason: the app did not produce the bytes it is reading. Stored data was
 * written by an older build, hand-edited through the storage app, or truncated
 * by a crashed write; a response was shaped by a service that changed without
 * telling anyone. Neither is malicious and both are routinely wrong, and the
 * failure they produce is the expensive kind — `undefined is not an object`
 * somewhere in a render, three layers from the read.
 *
 * `readJsonOr(path, fallback)` answers "the file is missing" and "the file is
 * garbage" with the same value, so a broken app renders identically to a fresh
 * one and the user's data is gone with no trace. The whole point of parsing at
 * the boundary is to keep those two answers apart: absent is silent, malformed
 * is logged, and either way the caller gets something it can render.
 *
 * Twenty-odd apps wrote that block by hand, along with a copy of this
 * rationale — five or six of them, already drifting. This is the block, and the
 * comment, written once.
 */

import { describeIssues, isStandardSchema } from './standard-schema.js';

/**
 * Validate `raw` against `schema`; on mismatch log it and return `fallback`.
 *
 * ```ts
 * const layout = safeParseOr(LayoutSchema, await appStorage.readJsonOr('layout.json', undefined), DEFAULT_LAYOUT, {
 *   label: 'storage:layout',
 * });
 * ```
 *
 * `undefined` — nothing stored, a key that was never written — is *absence*, not
 * corruption: it takes the fallback without logging, so a fresh install is quiet
 * even when the fallback itself would not satisfy the schema. Everything else
 * that fails is logged with the schema's own issues, because a value that is
 * present and wrong is the case worth seeing in the console.
 *
 * Throws, rather than falling back, on the two things that are the *caller's*
 * bug and not the data's: a `schema` that is not a Standard Schema, and one that
 * validates asynchronously (`await schema['~standard'].validate(raw)` yourself
 * for those — this returns a value, not a promise, so its callers can use it in
 * a store initializer). Both fail identically on every run, so failing loudly
 * costs one dev-loop iteration and hiding them costs a silent fallback forever.
 */
// The app-facing signature is the one in `bundled-types/index.d.ts`, where the
// return type is derived from the schema's own output type. This one is written
// for the SDK's internal consumers, which only need the fallback's shape.
export function safeParseOr<F>(
  schema: unknown,
  raw: unknown,
  fallback: F,
  opts?: { label?: string },
): F {
  const label = opts && opts.label ? `safeParseOr(${opts.label})` : 'safeParseOr';
  if (!isStandardSchema(schema)) {
    throw new TypeError(
      `[yaar] ${label}: expected a Standard Schema (e.g. a @bundled/zod schema), got ${typeof schema}`,
    );
  }
  if (raw === undefined) return fallback;

  const outcome = schema['~standard'].validate(raw);
  if (outcome && typeof outcome.then === 'function') {
    throw new TypeError(
      `[yaar] ${label}: schema validates asynchronously; await its ~standard.validate yourself`,
    );
  }
  if (outcome && outcome.issues && outcome.issues.length) {
    console.error(`[yaar] ${label}: using fallback - ${describeIssues(outcome.issues)}`);
    return fallback;
  }
  return outcome ? outcome.value : fallback;
}
