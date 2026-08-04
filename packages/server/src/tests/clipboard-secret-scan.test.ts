/**
 * `features/user/secret-scan.ts` — what gets taken out of a clipboard read, and what does not.
 *
 * Two properties are worth more than the pattern list itself, and both are asserted below:
 *
 *   - **Nothing that is not a credential is touched.** This runs on every clipboard read, so
 *     a pattern that fires on ordinary text silently mangles the user's pastes. Git SHAs,
 *     UUIDs, and base64 image data are the shapes most likely to be caught by accident.
 *   - **A finding never carries the value.** The findings are what gets reported to a model
 *     and written to `session_logs/`; a report that quotes the secret to say it removed it
 *     puts it in both of the places the redaction was for.
 */
import { describe, it, expect } from 'bun:test';
import { scanForSecrets, redactSecrets, describeRedactions } from '../features/user/secret-scan.js';

/**
 * Structurally valid, never issued. Each is the vendor's documented prefix plus filler of
 * the right length — which is the whole of what this tier claims to recognize.
 */
const SAMPLES = {
  'github-token': `ghp_${'a1B2c3D4e5'.repeat(3)}f6g7hi`,
  'github-fine-grained-pat': `github_pat_${'1'.repeat(22)}_${'b'.repeat(20)}`,
  'gitlab-token': `glpat-${'x'.repeat(20)}`,
  'anthropic-api-key': `sk-ant-api03-${'A'.repeat(30)}`,
  'openai-api-key': `sk-proj-${'B'.repeat(40)}`,
  'aws-access-key-id': 'AKIAIOSFODNN7EXAMPLE',
  'google-api-key': `AIza${'C'.repeat(35)}`,
  'slack-token': `xoxb-${'1'.repeat(12)}-${'D'.repeat(24)}`,
  'stripe-secret-key': `sk_live_${'E'.repeat(24)}`,
  'sendgrid-api-key': `SG.${'F'.repeat(22)}.${'g'.repeat(43)}`,
  'npm-token': `npm_${'h'.repeat(36)}`,
  'pypi-token': `pypi-${'i'.repeat(40)}`,
  'huggingface-token': `hf_${'j'.repeat(34)}`,
} as const;

describe('secret-scan — vendor-prefixed credentials', () => {
  for (const [kind, sample] of Object.entries(SAMPLES)) {
    it(`finds a ${kind} in surrounding prose`, () => {
      const text = `here is the key you asked for:\n\nTOKEN=${sample}\n\nlet me know.`;
      const matches = scanForSecrets(text);

      expect(matches).toHaveLength(1);
      expect(matches[0]!.kind).toBe(kind);
      // The span must cover the whole credential. A match that stops short leaves a usable
      // prefix in the redacted output, which is worse than not matching at all: it reports
      // success while leaking.
      expect(text.slice(matches[0]!.start, matches[0]!.end)).toBe(sample);
    });
  }

  it('takes a PEM block whole, body and all', () => {
    const key =
      '-----BEGIN OPENSSH PRIVATE KEY-----\n' +
      `${'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB'.repeat(3)}\n` +
      '-----END OPENSSH PRIVATE KEY-----';
    const { text, findings } = redactSecrets(`my deploy key:\n${key}\nthanks`);

    expect(findings).toEqual([{ kind: 'private-key', count: 1 }]);
    // The base64 body is the secret; matching only the header lines would leave it in place.
    expect(text).not.toContain('b3BlbnNzaC1rZXktdjEA');
    expect(text).toContain('my deploy key:');
  });

  it('redacts a truncated PEM block that lost its END line', () => {
    // A read trimmed at CLIPBOARD_TEXT_LIMIT can cut the footer off. Requiring it would mean
    // the largest keys — the ones most likely to be truncated — are the ones that get through.
    const cut = `-----BEGIN RSA PRIVATE KEY-----\n${'MIIEow'.repeat(20)}`;
    expect(redactSecrets(cut).findings).toEqual([{ kind: 'private-key', count: 1 }]);
  });

  it('takes the password out of a connection URL and leaves the rest legible', () => {
    const { text, findings } = redactSecrets(
      'DATABASE_URL=postgres://app:hunter2sekret@db.internal:5432/main',
    );

    expect(findings).toEqual([{ kind: 'url-password', count: 1 }]);
    expect(text).not.toContain('hunter2sekret');
    // Host and user survive: the agent can still say which database it was pointed at.
    expect(text).toContain('postgres://app:');
    expect(text).toContain('@db.internal:5432/main');
  });

  it('recognises a JWT by its header, not merely its shape', () => {
    // {"alg":"HS256","typ":"JWT"}
    const jwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${'a'.repeat(40)}.${'b'.repeat(43)}`;
    expect(scanForSecrets(jwt).map((m) => m.kind)).toEqual(['jwt']);

    // Same three-segment shape, but the first segment is not a JSON header. Tier 1 claims
    // only "this is a vendor credential", and this is not one.
    const notJwt = `eyJ${'z'.repeat(30)}.${'a'.repeat(40)}.${'b'.repeat(43)}`;
    expect(scanForSecrets(notJwt)).toHaveLength(0);
  });

  it('reports one credential once when two patterns could claim it', () => {
    // `sk-ant-...` is also a valid `sk-` shape. Two findings would read as two keys.
    const matches = scanForSecrets(`key: ${SAMPLES['anthropic-api-key']}`);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.kind).toBe('anthropic-api-key');
  });
});

describe('secret-scan — what it must leave alone', () => {
  const innocuous = [
    ['a git SHA', 'fixed in 01b05884a7d3e9f2c4b6a8d0e1f3c5b7a9d2e4f6'],
    ['a UUID', 'session 0eee0d17-f766-46a6-8abe-b46d1ff40ada reconnected'],
    ['base64 image data', `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUg'.repeat(8)}`],
    ['a placeholder in docs', 'set API_KEY=<your-key-here> before running'],
    ['an ordinary URL with a port', 'open http://127.0.0.1:8000/api/version'],
    ['prose about keys', 'The AWS access key lives in the credentials file, not in git.'],
    ['a long English sentence', 'x'.repeat(200)],
  ] as const;

  for (const [what, text] of innocuous) {
    it(`leaves ${what} untouched`, () => {
      expect(redactSecrets(text)).toEqual({ text, findings: [] });
    });
  }
});

describe('secret-scan — what the caller is handed', () => {
  it('never returns the value it removed', () => {
    const secret = SAMPLES['aws-access-key-id'];
    const { text, findings } = redactSecrets(`AWS_ACCESS_KEY_ID=${secret}`);

    // Both of these are logged and both reach a model. Either one carrying the value would
    // undo the redaction in the place it matters most.
    expect(JSON.stringify(findings)).not.toContain(secret);
    expect(describeRedactions(findings)).not.toContain(secret);
    expect(text).not.toContain(secret);
    expect(text).toContain('[redacted: aws-access-key-id #1]');
  });

  it('gives one repeated credential one placeholder, and two distinct ones two', () => {
    const a = SAMPLES['npm-token'];
    const b = SAMPLES['pypi-token'];

    const repeated = redactSecrets(`prod: ${a}\nstaging: ${a}`);
    // "the same token in both environments" is a fact about the config worth preserving.
    expect(repeated.text).toBe('prod: [redacted: npm-token #1]\nstaging: [redacted: npm-token #1]');
    expect(repeated.findings).toEqual([{ kind: 'npm-token', count: 1 }]);

    const distinct = redactSecrets(`npm: ${a}\npypi: ${b}`);
    expect(distinct.findings).toEqual([
      { kind: 'npm-token', count: 1 },
      { kind: 'pypi-token', count: 1 },
    ]);
  });

  it('tells the agent not to route around the redaction', () => {
    const summary = describeRedactions([{ kind: 'github-token', count: 1 }]);

    expect(summary).toContain('github-token');
    // The failure mode this sentence exists for: an agent that helpfully asks the user to
    // paste the key into the chat, landing it in the context window by an unscanned route.
    expect(summary).toMatch(/not ask the user to paste/i);
  });
});
