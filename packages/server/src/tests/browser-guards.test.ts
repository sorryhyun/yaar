/**
 * Tests for the Phase 3 browser consent + self-target guards.
 *
 * Mocks the domain allowlist and the permission-dialog emitter so the guard
 * policy can be exercised without a live session or Chrome. getPort() comes from
 * the real config (defaults to 8000 in tests), so YAAR's own origin is
 * http://localhost:8000.
 */
import { mock, describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import type { BrowserProvider, BrowserSession } from '../lib/browser/index.js';

// ── Mock domain allowlist ────────────────────────────────────────────────────

let allowAll = false;
let allowedDomains = new Set<string>();
const mockAddAllowedDomain = mock(async (d: string) => {
  allowedDomains.add(d);
  return true;
});

mock.module('../features/config/domains.js', () => ({
  isAllDomainsAllowed: mock(async () => allowAll),
  isDomainAllowed: mock(async (d: string) => allowedDomains.has(d)),
  addAllowedDomain: mockAddAllowedDomain,
  // Re-export the remaining real members so the mock is a complete stand-in.
  // Bun's mock.module replaces the module process-wide; if any export is
  // omitted, other modules importing it (http/routes/settings.ts,
  // handlers/config.ts) fail to link with "Export named X not found".
  readAllowedDomains: mock(async () => [...allowedDomains]),
  setAllowAllDomains: mock(async (v: boolean) => {
    allowAll = v;
    return true;
  }),
  extractDomain: (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  },
}));

// ── Stub the permission dialog ───────────────────────────────────────────────
//
// Deliberately NOT mock.module. That replaces the module process-wide and is never
// restored between files, so a stub carrying only this one method left every later
// test file with an emitter missing `on`/`off`/`emitActionWithFeedback` — and
// `new LiveSession()` died on `actionEmitter.on(...)`. It only stayed green locally
// because bun runs files in raw directory order, which differs on CI's filesystem.
// Patch the single method the guards actually call, and put it back afterwards.

const { actionEmitter } = await import('../session/action-emitter.js');
const { enforceBrowserGuards, isMutatingAction, isYaarOriginUrl } =
  await import('../features/browser/guards.js');

let dialogConfirms = true;
const mockDialog = mock(async () => dialogConfirms);

type Dialog = typeof actionEmitter.showPermissionDialogToSession;
beforeAll(() => {
  actionEmitter.showPermissionDialogToSession = mockDialog as unknown as Dialog;
});
afterAll(() => {
  // Drop the own property so the real prototype method is exposed again.
  delete (actionEmitter as Partial<typeof actionEmitter>).showPermissionDialogToSession;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const headless = { controlsUserBrowser: false } as BrowserProvider;
const local = { controlsUserBrowser: true } as BrowserProvider;
const sessionAt = (url: string) => ({ currentUrl: url }) as BrowserSession;

describe('browser guards', () => {
  beforeEach(() => {
    allowAll = false;
    allowedDomains = new Set();
    dialogConfirms = true;
    mockDialog.mockClear();
    mockAddAllowedDomain.mockClear();
  });

  it('classifies mutating vs read-only actions', () => {
    for (const a of ['click', 'type', 'evaluate', 'navigate', 'set_cookie', 'close_tab']) {
      expect(isMutatingAction(a)).toBe(true);
    }
    for (const a of ['screenshot', 'extract', 'html', 'get_cookies', 'list_tabs', 'wait_for']) {
      expect(isMutatingAction(a)).toBe(false);
    }
  });

  it('detects YAAR origin across loopback hosts', () => {
    expect(isYaarOriginUrl('http://localhost:8000/desktop')).toBe(true);
    expect(isYaarOriginUrl('http://127.0.0.1:8000/')).toBe(true);
    expect(isYaarOriginUrl('https://example.com')).toBe(false);
    expect(isYaarOriginUrl('http://localhost:3000')).toBe(false);
    expect(isYaarOriginUrl(undefined)).toBe(false);
  });

  it('allows read-only actions everywhere, even on YAAR itself', async () => {
    const r = await enforceBrowserGuards({
      provider: local,
      action: 'extract',
      session: sessionAt('http://localhost:8000/'),
      sessionId: 's1',
    });
    expect(r.ok).toBe(true);
  });

  it('does not guard when there is no session yet (create/open)', async () => {
    const r = await enforceBrowserGuards({
      provider: local,
      action: 'open',
      session: undefined,
      sessionId: 's1',
    });
    expect(r.ok).toBe(true);
  });

  it('refuses raw-DOM mutation of YAAR own tab (self-target)', async () => {
    const r = await enforceBrowserGuards({
      provider: local,
      action: 'click',
      session: sessionAt('http://localhost:8000/desktop'),
      sessionId: 's1',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/OS Actions|yaar:\/\//);
    // Self-target is blocked outright — no consent dialog is even shown.
    expect(mockDialog).not.toHaveBeenCalled();
  });

  it('allows self-target mutation when allowSelfTarget is set (session-agent door)', async () => {
    const r = await enforceBrowserGuards({
      provider: local,
      action: 'click',
      session: sessionAt('http://localhost:8000/desktop'),
      sessionId: 's1',
      allowSelfTarget: true,
    });
    // YAAR's own tab is not a user-login origin, so no consent dialog either.
    expect(r.ok).toBe(true);
    expect(mockDialog).not.toHaveBeenCalled();
  });

  it('headless provider needs no tab-control consent for sibling tabs', async () => {
    const r = await enforceBrowserGuards({
      provider: headless,
      action: 'click',
      session: sessionAt('https://example.com/page'),
      sessionId: 's1',
    });
    expect(r.ok).toBe(true);
    expect(mockDialog).not.toHaveBeenCalled();
  });

  it('local provider prompts for consent on a disallowed user tab, and records the grant', async () => {
    dialogConfirms = true;
    const r = await enforceBrowserGuards({
      provider: local,
      action: 'type',
      session: sessionAt('https://bank.com/login'),
      sessionId: 's1',
    });
    expect(r.ok).toBe(true);
    expect(mockDialog).toHaveBeenCalledTimes(1);
    expect(mockAddAllowedDomain).toHaveBeenCalledWith('bank.com');
  });

  it('local provider blocks when the user denies tab control', async () => {
    dialogConfirms = false;
    const r = await enforceBrowserGuards({
      provider: local,
      action: 'type',
      session: sessionAt('https://bank.com/login'),
      sessionId: 's1',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/denied/i);
    expect(mockAddAllowedDomain).not.toHaveBeenCalled();
  });

  it('local provider skips consent for an already-allowed domain', async () => {
    allowedDomains.add('example.com');
    const r = await enforceBrowserGuards({
      provider: local,
      action: 'click',
      session: sessionAt('https://example.com/'),
      sessionId: 's1',
    });
    expect(r.ok).toBe(true);
    expect(mockDialog).not.toHaveBeenCalled();
  });

  it('local provider blocks with guidance when no session is available for a dialog', async () => {
    const r = await enforceBrowserGuards({
      provider: local,
      action: 'click',
      session: sessionAt('https://example.com/'),
      sessionId: undefined,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/yaar:\/\/config\/domains/);
  });
});
