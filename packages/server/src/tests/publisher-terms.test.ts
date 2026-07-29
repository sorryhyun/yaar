/**
 * The publisher agreement gate (`features/apps/publisher-terms.ts`).
 *
 * Nothing here touches the network or a Google session: the store is a JSON file
 * under `YAAR_CONFIG`, and every function that needs an identity takes the email as
 * an argument. The one function that resolves the *signed-in* publisher
 * (`acceptForSignedInPublisher`) is exercised only for its signed-out refusal, which
 * is the branch a test process can reach honestly — `test/env.ts` points
 * `YAAR_CONFIG` at a throwaway dir, so there are no stored credentials.
 *
 * `YAAR_CONFIG` is re-pointed at this suite's own temp dir rather than reusing the
 * shared one: `getConfigDir()` is read per call, and the unit partition runs files
 * concurrently in one process, so a suite that writes into the common config dir is
 * writing where another suite may be reading.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PUBLISHER_TERMS_VERSION,
  acceptForSignedInPublisher,
  acceptPublisherTerms,
  getPublisherTerms,
  getTermsAcceptance,
  termsGateError,
} from '../features/apps/publisher-terms.js';

let configRoot: string;
let previousConfig: string | undefined;

const EMAIL = 'publisher@example.com';

beforeAll(async () => {
  previousConfig = process.env.YAAR_CONFIG;
  configRoot = await mkdtemp(join(tmpdir(), 'yaar-terms-'));
  process.env.YAAR_CONFIG = configRoot;
});

afterAll(async () => {
  if (previousConfig === undefined) delete process.env.YAAR_CONFIG;
  else process.env.YAAR_CONFIG = previousConfig;
  await rm(configRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(join(configRoot, 'publisher-terms.json'), { force: true });
});

describe('the terms themselves', () => {
  it('carries a version and text, and the text names that version', () => {
    const terms = getPublisherTerms();
    expect(terms.version).toBe(PUBLISHER_TERMS_VERSION);
    expect(terms.text).toContain(`v${PUBLISHER_TERMS_VERSION}`);
    expect(terms.text.length).toBeGreaterThan(200);
  });
});

describe('acceptance', () => {
  it('starts unaccepted and blocks publishing with an actionable reason', async () => {
    const standing = await getTermsAcceptance(EMAIL);
    expect(standing.accepted).toBe(false);
    expect(standing.acceptedVersion).toBeNull();

    const reason = await termsGateError(EMAIL);
    expect(reason).toContain(`v${PUBLISHER_TERMS_VERSION}`);
    // The fix has to be in the message — an agent hitting this has no dialog.
    expect(reason).toContain('Market Apps');
  });

  it('accepting the current version opens the gate', async () => {
    await acceptPublisherTerms(EMAIL, PUBLISHER_TERMS_VERSION);

    const standing = await getTermsAcceptance(EMAIL);
    expect(standing.accepted).toBe(true);
    expect(standing.acceptedVersion).toBe(PUBLISHER_TERMS_VERSION);
    expect(standing.acceptedAt).toBeTruthy();
    expect(await termsGateError(EMAIL)).toBeNull();
  });

  it('is keyed by publisher, not by machine — another account is asked again', async () => {
    await acceptPublisherTerms(EMAIL, PUBLISHER_TERMS_VERSION);
    expect(await termsGateError('someone-else@example.com')).not.toBeNull();
  });

  it('ignores the casing the email was typed in', async () => {
    await acceptPublisherTerms('Publisher@Example.COM', PUBLISHER_TERMS_VERSION);
    expect(await termsGateError(EMAIL)).toBeNull();
  });

  it('refuses to record a version that is not current', async () => {
    await expect(acceptPublisherTerms(EMAIL, 'not-a-version')).rejects.toThrow(
      /not current|v1 is/i,
    );
    expect(await termsGateError(EMAIL)).not.toBeNull();
  });

  it('stops counting once the terms version moves on, and says so', async () => {
    // Write an acceptance of a superseded version directly — the public API refuses
    // to record one, which is the point being asserted from the other side.
    await writeFile(
      join(configRoot, 'publisher-terms.json'),
      JSON.stringify({
        accepted: { [EMAIL]: { version: 'older', acceptedAt: new Date().toISOString() } },
      }),
    );

    const standing = await getTermsAcceptance(EMAIL);
    expect(standing.accepted).toBe(false);
    expect(standing.acceptedVersion).toBe('older');
    expect(await termsGateError(EMAIL)).toContain('have changed');
  });

  it('treats a signed-out publisher as unaccepted rather than throwing', async () => {
    const standing = await getTermsAcceptance(null);
    expect(standing.accepted).toBe(false);
    expect(await termsGateError(null)).not.toBeNull();

    // No stored Google credentials in a test config dir, so this is the signed-out path.
    const result = await acceptForSignedInPublisher(PUBLISHER_TERMS_VERSION);
    expect(result.ok).toBe(false);
  });

  it('survives a corrupt store by asking again rather than crashing', async () => {
    await writeFile(join(configRoot, 'publisher-terms.json'), '{ this is not json');
    expect(await termsGateError(EMAIL)).not.toBeNull();

    // And a later acceptance rewrites the file cleanly.
    await acceptPublisherTerms(EMAIL, PUBLISHER_TERMS_VERSION);
    const parsed = JSON.parse(await readFile(join(configRoot, 'publisher-terms.json'), 'utf-8'));
    expect(parsed.accepted[EMAIL].version).toBe(PUBLISHER_TERMS_VERSION);
    expect(await termsGateError(EMAIL)).toBeNull();
  });
});
