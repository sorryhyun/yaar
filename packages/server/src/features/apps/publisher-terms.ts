/**
 * The publisher agreement a user accepts before an app leaves this machine.
 *
 * Publishing is the one YAAR action that puts a user's code in front of other
 * people, under an identity that is theirs (`features/market/google-auth.ts`), in a
 * place they cannot fully take it back from. That deserves an explicit "yes", and a
 * record of *which* yes — so the terms carry a version and an acceptance is only
 * good for the version it named.
 *
 * Three properties are deliberate:
 *
 *  - **Keyed by publisher email, not by machine.** The agreement is between the
 *    marketplace and a Google identity. Two accounts on one laptop are two
 *    publishers; signing out and in as someone else asks again.
 *  - **The text is a constant, not a file or a URL.** A bundled exe has no
 *    `docs/` beside it and a link can 404 or change under the reader — neither is
 *    something to gate consent on. What the dialog renders is what is in this file,
 *    and bumping `PUBLISHER_TERMS_VERSION` is what re-asks everyone.
 *  - **The gate lives at the upload chokepoint** (`publish.ts`'s `uploadTarball`),
 *    not in the UI. The dialog is the pleasant path; an agent calling
 *    `invoke('yaar://apps/x', { action: 'publish' })` hits the same refusal, and
 *    cannot accept on the user's behalf — accepting takes a `publish_confirm` that
 *    names the version, which is a thing the human dialog sends.
 */

import { join, dirname } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { getConfigDir } from '../../config.js';
import { getAuthStatus } from '../market/google-auth.js';

/**
 * Bump this when the text below changes materially. Every publisher is asked again
 * on their next publish; an acceptance of an older version stops counting.
 */
export const PUBLISHER_TERMS_VERSION = '1';

export const PUBLISHER_TERMS_TEXT = `YAAR Marketplace — Publisher Terms (v${PUBLISHER_TERMS_VERSION})

By publishing an app to the YAAR marketplace you confirm that:

1. Rights. You wrote the app, or you hold the rights to distribute it. Publishing
   it here infringes no one else's copyright, trademark, or licence terms.

2. It becomes public. Publishing uploads your app's source to a public repository.
   Anyone can read, install, fork, and copy it. Treat a publish as permanent —
   removal is best-effort, and a version someone already installed is theirs.

3. Nothing secret goes up. The upload is your app directory as it stands: source,
   app.json, and any other file beside them. API keys, tokens, and personal data
   committed there are published with it. Check before you confirm.

4. Your identity is attached. The Google account you signed in with is recorded
   with every publish and is what claims and proves ownership of the app id.

5. No hostile code. You will not publish code that damages a machine or its data,
   exfiltrates files or credentials, or misrepresents what it does. Apps run with
   the permissions their app.json declares — declare only what you actually use.

6. Distributed as-is. Your app reaches other people as-is. YAAR does not review,
   endorse, or warrant it, and you are responsible for what it does on their
   machines.

7. Removal. The marketplace may remove an app or withdraw publishing access,
   in particular for the above.

These terms may change. A new version has to be accepted before your next publish.`;

/** The agreement itself — version plus the exact text the user is shown. */
export interface PublisherTerms {
  version: string;
  text: string;
}

/** Where a given publisher stands against the *current* terms. */
export interface TermsAcceptance extends PublisherTerms {
  /** True only when this publisher accepted this exact version. */
  accepted: boolean;
  /** The version they last accepted, if any — may be older than `version`. */
  acceptedVersion: string | null;
  acceptedAt: string | null;
}

interface AcceptanceRecord {
  version: string;
  acceptedAt: string;
}

/** `config/publisher-terms.json` — `{ accepted: { "<email>": { version, acceptedAt } } }`. */
interface AcceptanceFile {
  accepted: Record<string, AcceptanceRecord>;
}

function acceptancePath(): string {
  return join(getConfigDir(), 'publisher-terms.json');
}

/** Google addresses are case-insensitive; the key must not depend on how it was typed. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function readAcceptances(): Promise<AcceptanceFile> {
  try {
    const parsed = JSON.parse(await readFile(acceptancePath(), 'utf-8')) as Partial<AcceptanceFile>;
    // Hand-edited or truncated files are treated as "nobody has accepted" rather
    // than crashing a publish — the only cost of being wrong here is asking again.
    return { accepted: parsed?.accepted ?? {} };
  } catch {
    return { accepted: {} };
  }
}

export function getPublisherTerms(): PublisherTerms {
  return { version: PUBLISHER_TERMS_VERSION, text: PUBLISHER_TERMS_TEXT };
}

/**
 * Where `email` stands. A null email (signed out) is never "accepted" — there is
 * no publisher to have agreed to anything.
 */
export async function getTermsAcceptance(email: string | null): Promise<TermsAcceptance> {
  const terms = getPublisherTerms();
  if (!email) {
    return { ...terms, accepted: false, acceptedVersion: null, acceptedAt: null };
  }
  const record = (await readAcceptances()).accepted[normalizeEmail(email)];
  return {
    ...terms,
    accepted: record?.version === terms.version,
    acceptedVersion: record?.version ?? null,
    acceptedAt: record?.acceptedAt ?? null,
  };
}

/** The signed-in publisher's standing, or the signed-out answer when there is none. */
export async function getTermsAcceptanceForSignedInPublisher(): Promise<TermsAcceptance> {
  const { email } = await getAuthStatus();
  return getTermsAcceptance(email);
}

/**
 * Record that `email` accepted `version`.
 *
 * A version that isn't the current one is refused rather than stored: it would be
 * a caller agreeing to text nobody is showing, and storing it would satisfy no
 * gate anyway.
 */
export async function acceptPublisherTerms(email: string, version: string): Promise<void> {
  if (version !== PUBLISHER_TERMS_VERSION) {
    throw new Error(
      `Publisher terms v${version} are not current — v${PUBLISHER_TERMS_VERSION} is. ` +
        'Re-open the publish dialog to review and accept the current terms.',
    );
  }
  const file = await readAcceptances();
  file.accepted[normalizeEmail(email)] = { version, acceptedAt: new Date().toISOString() };

  const path = acceptancePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2) + '\n');
}

/**
 * Accept on behalf of whoever is signed in. Returns the reason on failure rather
 * than throwing, because both callers are answering an HTTP-shaped request.
 */
export async function acceptForSignedInPublisher(
  version: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { email } = await getAuthStatus();
  if (!email) {
    return { ok: false, error: 'Not signed in to Google — sign in before accepting the terms.' };
  }
  try {
    await acceptPublisherTerms(email, version);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * The gate: the reason this publisher may not publish, or null when they may.
 *
 * Phrased so the fix is in the message — the caller may be an agent with no dialog
 * in front of it, and "accept the terms" is only actionable if it says where.
 */
export async function termsGateError(email: string | null): Promise<string | null> {
  const standing = await getTermsAcceptance(email);
  if (standing.accepted) return null;

  const changed = standing.acceptedVersion
    ? `The Publisher Terms have changed since you accepted v${standing.acceptedVersion}. `
    : '';
  return (
    `${changed}Publishing requires accepting the YAAR Marketplace Publisher Terms ` +
    `(v${standing.version}). Open the Market Apps window and press Publish — the ` +
    'confirmation dialog shows the terms and records your acceptance.'
  );
}
