/**
 * A devtools preview runs under its own app principal.
 *
 * The preview needs a real identity or `self` does not resolve, and every feature touching
 * appStorage/appDb/app-scoped permissions cannot be run even once before deploy — the code
 * ships on an argument rather than a test. But it must not be the *deployed app's* identity:
 * that would hand unshipped code the live app's storage, and would let the preview window
 * claim the app's active-window slot, so cross-app control and direct messages meant for the
 * running app would steer into the preview iframe instead.
 *
 * These tests pin the seam between those two failures.
 */
import { describe, it, expect } from 'bun:test';
import { isPreviewAppId, previewAppId, extractAppId } from '@yaar/shared';
import { parseContentPath } from '../lib/yaar-uri-server.js';

describe('preview app identity', () => {
  it('is distinct from the app it previews', () => {
    expect(previewAppId('1752345678901')).toBe('preview--1752345678901');
    expect(isPreviewAppId(previewAppId('1752345678901'))).toBe(true);
  });

  it('does not mistake a deployed app for a preview', () => {
    // The gate that keeps previews from claiming an app agent reads this, so a false
    // positive here would silently stop a real app's window from being driven at all.
    for (const appId of ['ai-chat', 'devtools', 'preview', 'preview-notes', 'browser-user']) {
      expect(isPreviewAppId(appId)).toBe(false);
    }
    expect(isPreviewAppId(undefined)).toBe(false);
  });

  it('is a legal app id everywhere an app id is parsed', () => {
    // The principal has to survive every path an ordinary appId takes — the id is what
    // `self` expands to, so a parser that rejects it turns straight back into the 403 this
    // is meant to remove. The double hyphen is the only unusual thing about it.
    const parsed = parseContentPath(`/api/apps/${previewAppId('1752345678901')}/dist/index.html`);
    expect(parsed).toEqual({
      authority: 'apps',
      appId: 'preview--1752345678901',
      path: 'dist/index.html',
    });
  });

  it('names a storage namespace the deployed app does not share', () => {
    // The reason for a separate principal at all: unshipped code must not be able to
    // reach — or corrupt — the running app's live storage.
    expect(previewAppId('1752345678901')).not.toBe('ai-chat');
    const previewDir = parseContentPath(`/api/apps/${previewAppId('1752345678901')}/notes.json`);
    const realDir = parseContentPath('/api/apps/ai-chat/notes.json');
    expect(previewDir).not.toEqual(realDir);
  });

  it('round-trips through a yaar://apps URI', () => {
    // appStorage and appDb both address themselves as yaar://apps/self/..., which the verb
    // route rewrites to the principal. If that URI did not parse, `self` would 403 exactly
    // as it did when a preview had no appId at all.
    const uri = `yaar://apps/${previewAppId('1752345678901')}/storage/notes.json`;
    expect(extractAppId(uri)).toBe('preview--1752345678901');
  });
});
