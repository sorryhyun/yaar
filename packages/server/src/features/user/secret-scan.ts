/**
 * Credential detection for clipboard reads — vendor-anchored tokens only.
 *
 * The clipboard is the one door in YAAR that hands an agent whatever the user last copied,
 * and with `YAAR_CLIPBOARD_GRANT` on (the default) it does so with no browser prompt and no
 * visible indication. The thing people most often have on a clipboard that they did not mean
 * to publish is a credential: an `.env` line, a token pasted from a provider console, a key
 * on its way into a config file. Once it reaches a model it is in the context window and in
 * `session_logs/`, and neither is revocable.
 *
 * **This module detects exactly one class of secret: a string carrying a vendor's own
 * prefix.** `ghp_`, `sk-ant-`, `AKIA`, a PEM header. That is a deliberate floor rather than
 * an attempt at coverage. Two richer tiers exist and are not here:
 *
 *   - *labeled assignments* — `API_KEY=<something>`, keyed on the name rather than the value.
 *   - *entropy* — a long base64/hex run with no label at all.
 *
 * Both trade precision for recall, and both need a way for the user to say "that was my
 * minified bundle, stop it". Until there is somewhere for that decision to live, shipping
 * them would mean silently mangling ordinary pastes. What is here fires only on strings that
 * are a credential or a near-perfect imitation of one, so it needs no such escape hatch.
 *
 * **No checksum verification, on purpose.** GitHub and Stripe tokens carry a CRC32 in their
 * last characters, and checking it would cut the (already tiny) false-positive rate. But the
 * two errors do not cost the same: a false positive costs one redacted paragraph, a false
 * negative puts a live key in a model's context forever. A checksum can only ever *reject* a
 * match, so a bug in it leaks — it can only move the result in the expensive direction. The
 * vendor prefix plus a length is precise enough without taking that trade.
 *
 * The scan returns **spans, never values**. Nothing downstream needs the secret in order to
 * report that it found one, and a finding that carries the bytes is a finding that will
 * eventually be logged.
 */

/** One detector. `group` narrows the redacted span to a capture (a URL's password, say). */
interface SecretPattern {
  kind: string;
  /** Must carry `d` (for `indices`) and `g` (for `matchAll`). */
  re: RegExp;
  group?: number;
  /** Last word on a shape that is common enough to imitate by accident. */
  verify?: (value: string) => boolean;
}

/** Where a credential sits in the text, and what kind it is. Never the value itself. */
export interface SecretMatch {
  kind: string;
  start: number;
  end: number;
}

/** What was removed, by kind, counting *distinct* values rather than occurrences. */
export interface SecretFinding {
  kind: string;
  count: number;
}

/**
 * `eyJ` is just base64 for `{"`, so a JWT shape is the one here that a plain data blob can
 * wear by accident. Decoding the header and insisting on an `alg` costs a JSON parse and
 * settles it. A rejected match is not "safe", only "not a JWT" — which is the entirety of
 * what this tier claims about it.
 */
function looksLikeJwt(value: string): boolean {
  const header = value.split('.')[0] ?? '';
  try {
    const json = Buffer.from(header.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    const parsed: unknown = JSON.parse(json);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { alg?: unknown }).alg === 'string'
    );
  } catch {
    return false;
  }
}

/**
 * Order matters twice over. Overlapping matches are resolved longest-first and then by
 * position in this list, so the whole-block and more-specific patterns belong above the
 * shapes they contain — a PEM body must not be re-matched piecemeal by anything below it.
 */
const PATTERNS: readonly SecretPattern[] = [
  {
    // A truncated read can cut the END line off, so the block runs to it *or* to the end of
    // the text. Half a private key is not usable, but it is also not something to hand over.
    kind: 'private-key',
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|$)/dg,
  },
  { kind: 'anthropic-api-key', re: /\bsk-ant-[A-Za-z0-9_-]{24,}/dg },
  // Anthropic keys are `sk-` too, and are matched by their own rule above.
  { kind: 'openai-api-key', re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/dg },
  { kind: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/dg },
  { kind: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,}/dg },
  { kind: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}/dg },
  { kind: 'aws-access-key-id', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/dg },
  { kind: 'google-api-key', re: /\bAIza[A-Za-z0-9_-]{35}\b/dg },
  { kind: 'slack-token', re: /\bxox[abprse]-[A-Za-z0-9-]{10,}/dg },
  {
    kind: 'slack-webhook',
    re: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_/-]{10,}/dg,
  },
  { kind: 'stripe-secret-key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/dg },
  { kind: 'sendgrid-api-key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/dg },
  { kind: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/dg },
  { kind: 'pypi-token', re: /\bpypi-[A-Za-z0-9_-]{32,}/dg },
  { kind: 'huggingface-token', re: /\bhf_[A-Za-z0-9]{30,}\b/dg },
  {
    kind: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/dg,
    verify: looksLikeJwt,
  },
  {
    // `DATABASE_URL=postgres://app:hunter2@host/db` — the password, not the whole URL, so
    // what comes back still says which host and which user the agent was looking at.
    kind: 'url-password',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]+:([^\s/?#@]{3,})@/dg,
    group: 1,
  },
];

/** Every credential in `text`, non-overlapping, in the order they appear. */
export function scanForSecrets(text: string): SecretMatch[] {
  const found: Array<SecretMatch & { order: number }> = [];

  PATTERNS.forEach((pattern, order) => {
    pattern.re.lastIndex = 0;
    for (const match of text.matchAll(pattern.re)) {
      const span = match.indices?.[pattern.group ?? 0];
      if (!span) continue;
      if (pattern.verify && !pattern.verify(text.slice(span[0], span[1]))) continue;
      found.push({ kind: pattern.kind, start: span[0], end: span[1], order });
    }
  });

  // Longest wins, then the earlier (more specific) pattern. Anything inside a kept span is
  // dropped: one credential reported twice under two names reads like two credentials.
  found.sort((a, b) => a.start - b.start || b.end - a.end || a.order - b.order);

  const kept: SecretMatch[] = [];
  let consumedTo = -1;
  for (const match of found) {
    if (match.start < consumedTo) continue;
    kept.push({ kind: match.kind, start: match.start, end: match.end });
    consumedTo = match.end;
  }
  return kept;
}

export interface RedactionResult {
  text: string;
  findings: SecretFinding[];
}

/**
 * Replace every credential with a placeholder naming what it was.
 *
 * The same value always gets the same placeholder within one call, so the surrounding text
 * still says what it said: an agent reading a config can tell "the same key appears in both
 * environments" from "these are two different keys" without ever seeing either.
 */
export function redactSecrets(text: string): RedactionResult {
  const matches = scanForSecrets(text);
  if (matches.length === 0) return { text, findings: [] };

  const placeholders = new Map<string, string>();
  const counts = new Map<string, number>();
  let out = '';
  let cursor = 0;

  for (const match of matches) {
    const value = text.slice(match.start, match.end);
    let placeholder = placeholders.get(value);
    if (!placeholder) {
      const nth = (counts.get(match.kind) ?? 0) + 1;
      counts.set(match.kind, nth);
      placeholder = `[redacted: ${match.kind} #${nth}]`;
      placeholders.set(value, placeholder);
    }
    out += text.slice(cursor, match.start) + placeholder;
    cursor = match.end;
  }
  out += text.slice(cursor);

  return {
    text: out,
    findings: [...counts].map(([kind, count]) => ({ kind, count })),
  };
}

/**
 * The sentence the agent is given alongside redacted content.
 *
 * Written here rather than by the caller because the agent is the party being restricted,
 * and the one thing it must not conclude is that the user should paste the secret into the
 * chat instead — which is exactly what a bare "some content was removed" invites.
 */
export function describeRedactions(findings: SecretFinding[]): string {
  const total = findings.reduce((sum, f) => sum + f.count, 0);
  const inventory = findings.map((f) => `${f.count}× ${f.kind}`).join(', ');
  return (
    `${total} credential${total === 1 ? '' : 's'} (${inventory}) ` +
    `${total === 1 ? 'was' : 'were'} removed from this clipboard content before it reached ` +
    'you, and replaced with placeholders. The rest is verbatim. Do not ask the user to paste ' +
    'the value into the conversation — that puts it in exactly the places this kept it out ' +
    'of. If an operation genuinely needs it, have the user supply it to the tool that needs ' +
    'it, or turn the scan off with YAAR_CLIPBOARD_SECRETS=0 if they accept the trade.'
  );
}
