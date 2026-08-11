/**
 * App-id policy — the shape rule and the two reservations.
 *
 * `self` is reserved because it is the pronoun `resolveSelf` expands to the caller's own
 * id (see `self-resolution.test.ts` for the expansion itself). An app installed under the
 * literal name would be unaddressable: every `yaar://apps/self/…` another app wrote would
 * expand before the match ever saw a literal `self`. The bug is shadowing, not widening,
 * which is exactly why it would never show up as a denied request — hence this test rather
 * than a gate assertion somewhere downstream.
 *
 * `preview--` is reserved because `PREVIEW_APP_PREFIX` guards a devtools preview's
 * identity by convention only ("would not normally contain one"); a deployed app holding
 * one would share a storage namespace and an active-window slot with the preview.
 */

import { describe, it, expect } from 'bun:test';
import { PREVIEW_APP_PREFIX } from '@yaar/shared';
import { appIdRefusal } from '../features/apps/roots.js';

describe('appIdRefusal', () => {
  it('accepts an ordinary kebab-case id', () => {
    for (const id of ['notes', 'my-app', 'a', 'app2', 'x-1-y']) {
      expect(appIdRefusal(id)).toBeNull();
    }
  });

  it('refuses `self`, the pronoun every app writes to mean itself', () => {
    expect(appIdRefusal('self')).toContain('reserved');
  });

  it('refuses the preview prefix, not merely the word preview', () => {
    expect(appIdRefusal(`${PREVIEW_APP_PREFIX}my-project`)).toContain('reserved');
    // A single hyphen is not the prefix, and `preview` alone is a legitimate app name.
    expect(appIdRefusal('preview')).toBeNull();
    expect(appIdRefusal('preview-tool')).toBeNull();
  });

  it('leaves ids that merely start with the reserved word alone', () => {
    // `namesSelf` has the same boundary: `apps/selfie` is not `apps/self`.
    expect(appIdRefusal('selfie')).toBeNull();
    expect(appIdRefusal('self-hosted')).toBeNull();
  });

  it('refuses anything that is not a safe single path segment', () => {
    for (const id of ['..', '.', 'a/b', 'App', 'my_app', '-lead', '2fast', '', 'a b']) {
      expect(appIdRefusal(id)).toContain('Invalid app id');
    }
  });

  it('reports a reason, never a bare false — every caller shows it to a human', () => {
    expect(appIdRefusal('self')).toMatch(/self/);
    expect(appIdRefusal('..')).toMatch(/\.\./);
  });
});
