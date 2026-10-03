/**
 * Fault rules for devtools preview windows — make a preview's own verb and HTTP calls fail,
 * stall, or hang, so an app's error and loading paths can be exercised without breaking
 * the thing it talks to.
 *
 * Enforced on the server, at the doors the iframe's calls arrive through (`/api/verb*`,
 * `/api/fetch`; see `http/preview-faults.ts`), rather than by patching `window.fetch` from
 * an eval. A page-side wrapper works for calls made after it is installed, but dies with
 * every reload, so it can never reach the calls an app makes while it boots: the "first
 * load fails" case most worth testing. And it would have to dig the `yaar://` URI out of a
 * request body, where here the door already holds it resolved.
 *
 * Scoped like `app_eval` (`isPreviewWindow`): rules can only be set on a preview, and they
 * match only calls whose iframe token names that window — re-checked as a preview on every
 * call — so an installed app's traffic cannot be touched. They outlive a close of the
 * preview, because devtools refreshes a preview onto each new build by re-creating it under
 * the same id; they last until cleared or the session ends (`WindowStateRegistry.faults`).
 */

import { ok, okJson, error, type VerbResult } from '../../lib/verb-result.js';
import type { Verb } from '../../handlers/uri-registry.js';
import type { WindowStateRegistry } from '../../session/window-state.js';
import { isPreviewWindow } from './app-protocol.js';

export type PreviewFaultKind = 'fail' | 'delay' | 'hang';

export interface PreviewFaultRule {
  /** A `yaar://` URI or an http(s) URL; `*` matches any run of characters, `/` included. */
  match: string;
  kind: PreviewFaultKind;
  /** yaar:// rules only: restrict to these verbs. Absent means every verb. */
  verbs?: Verb[];
  /** `fail`: the HTTP status the door answers with (default 500 verb, 502 fetch). */
  status?: number;
  /** `fail`: the error message the app sees. */
  error?: string;
  /** `fail` on a verb: answer as a retryable 503, which the verb SDK retries before giving up. */
  retryable?: boolean;
  /** `delay`: how long to stall before the call proceeds. `fail`: how long before it fails. */
  delayMs?: number;
  /** Stop matching after this many hits — `times: 1` fails the first call and lets the retry through. */
  times?: number;
  /** How many calls this rule has caught so far. */
  hits: number;
}

export const MAX_FAULT_RULES = 32;
const MAX_PATTERN_LENGTH = 2048;
const VERBS: readonly Verb[] = ['describe', 'read', 'list', 'invoke', 'delete'];
const KINDS: readonly PreviewFaultKind[] = ['fail', 'delay', 'hang'];

/** What a door knows about the call it is about to make. */
export interface FaultTarget {
  /**
   * Every spelling of the call's target worth matching: the URI as the app wrote it and as
   * the door resolved it (`yaar://apps/self/…` → the real app id), or the request URL.
   */
  targets: string[];
  /** The yaar verb, for verb doors. Absent for an HTTP fetch. */
  verb?: Verb;
}

function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`);
}

/**
 * The first live rule that catches this call, with its hit counted. Rules are tried in the
 * order they were given, so a narrow rule placed before a broad one wins.
 */
export function takeMatchingFault(
  rules: readonly PreviewFaultRule[],
  { targets, verb }: FaultTarget,
): PreviewFaultRule | undefined {
  for (const rule of rules) {
    if (rule.times !== undefined && rule.hits >= rule.times) continue;
    const isVerbRule = rule.match.startsWith('yaar://');
    // A verb rule never catches a fetch, and an http rule never catches a verb: the two
    // namespaces cannot collide, but a bare `*` would otherwise catch everything twice over.
    if (isVerbRule !== (verb !== undefined)) continue;
    if (rule.verbs && verb && !rule.verbs.includes(verb)) continue;
    const re = globToRegExp(rule.match);
    if (!targets.some((t) => re.test(t))) continue;
    rule.hits++;
    return rule;
  }
  return undefined;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** Validate a caller's rule list. Each refusal names the rule and the field. */
export function parseFaultRules(raw: unknown): { rules: PreviewFaultRule[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: '"rules" must be an array (pass [] to clear).' };
  if (raw.length > MAX_FAULT_RULES) {
    return { error: `At most ${MAX_FAULT_RULES} fault rules per window (got ${raw.length}).` };
  }
  const rules: PreviewFaultRule[] = [];
  for (const [i, r] of raw.entries()) {
    const at = `rules[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r))
      return { error: `${at} must be an object.` };
    const o = r as Record<string, unknown>;
    if (typeof o.match !== 'string' || !o.match || o.match.length > MAX_PATTERN_LENGTH) {
      return { error: `${at}.match must be a non-empty string (a yaar:// URI or http(s) URL).` };
    }
    if (!/^(yaar|https?):\/\//.test(o.match)) {
      return {
        error:
          `${at}.match "${o.match}" must start with yaar://, http:// or https://. A ` +
          'same-origin relative fetch never leaves the iframe through a door this can watch.',
      };
    }
    if (typeof o.kind !== 'string' || !KINDS.includes(o.kind as PreviewFaultKind)) {
      return { error: `${at}.kind must be one of ${KINDS.join(', ')}.` };
    }
    const rule: PreviewFaultRule = { match: o.match, kind: o.kind as PreviewFaultKind, hits: 0 };
    if (o.verbs !== undefined) {
      if (!o.match.startsWith('yaar://')) {
        return { error: `${at}.verbs only applies to a yaar:// match.` };
      }
      if (!Array.isArray(o.verbs) || !o.verbs.every((v) => VERBS.includes(v as Verb))) {
        return { error: `${at}.verbs must be an array of ${VERBS.join(', ')}.` };
      }
      rule.verbs = o.verbs as Verb[];
    }
    if (o.status !== undefined) {
      if (!isNonNegativeInt(o.status) || o.status < 400 || o.status > 599) {
        return { error: `${at}.status must be an HTTP error status (400-599).` };
      }
      rule.status = o.status;
    }
    if (o.error !== undefined) {
      if (typeof o.error !== 'string') return { error: `${at}.error must be a string.` };
      rule.error = o.error.slice(0, 1000);
    }
    if (o.retryable !== undefined) {
      if (typeof o.retryable !== 'boolean') return { error: `${at}.retryable must be a boolean.` };
      rule.retryable = o.retryable;
    }
    if (o.delayMs !== undefined) {
      if (!isNonNegativeInt(o.delayMs)) {
        return { error: `${at}.delayMs must be a non-negative integer.` };
      }
      rule.delayMs = o.delayMs;
    }
    if (o.times !== undefined) {
      if (!isNonNegativeInt(o.times) || o.times === 0) {
        return { error: `${at}.times must be a positive integer.` };
      }
      rule.times = o.times;
    }
    if (rule.kind === 'delay' && rule.delayMs === undefined) {
      return { error: `${at}: a "delay" rule needs delayMs.` };
    }
    if (rule.kind !== 'fail' && (rule.status || rule.error || rule.retryable)) {
      return { error: `${at}: status, error and retryable only apply to a "fail" rule.` };
    }
    rules.push(rule);
  }
  return { rules };
}

/**
 * Handle app_faults: set, clear or report the fault rules of a devtools preview window.
 *
 * `rules` replaces the whole list (`[]` clears it); omitting it reports the current list
 * with each rule's hit count, which is how a caller learns whether the app made the call
 * it meant to break at all.
 */
export function handlePreviewFaults(
  windowState: WindowStateRegistry,
  windowId: string,
  payload: Record<string, unknown>,
): VerbResult {
  const win = windowState.getWindow(windowId);
  if (!win) return error(`Window "${windowId}" not found.`);
  if (win.content.renderer !== 'iframe') return error(`Window "${windowId}" is not an iframe app.`);
  if (!isPreviewWindow(win)) {
    return error(
      `app_faults is refused for window "${windowId}": it is not a devtools preview. ` +
        'Fault injection is allowed only in the throwaway preview windows devtools builds ' +
        'from source (window id "devtools-preview-{projectId}").',
    );
  }

  if (payload.rules === undefined) {
    return okJson({ rules: windowState.getWindowFaults(win.id, undefined, isPreviewWindow) });
  }
  const parsed = parseFaultRules(payload.rules);
  if ('error' in parsed) return error(parsed.error);
  windowState.setWindowFaults(win.id, parsed.rules);
  return ok(
    parsed.rules.length === 0
      ? `Cleared the fault rules of "${windowId}".`
      : `Set ${parsed.rules.length} fault rule(s) on "${windowId}". They apply to the ` +
          "preview iframe's own verb and cross-origin fetch calls until replaced or cleared " +
          '— a reload, or a re-created preview under the same id, keeps them.',
  );
}
