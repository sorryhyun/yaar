/**
 * In YAAR's own window the agent-triggered clipboard read goes through `window.yaarHost`:
 * WKWebView refuses `navigator.clipboard.read*` with a NotAllowedError no grant clears.
 * Without a host the browser path is untouched.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { YAAR_HOST_VERSION, type YaarHost } from '@yaar/shared';

const sent: Record<string, unknown>[] = [];
mock.module('@/lib/transport/transport-manager', () => ({
  wsManager: {},
  sendEvent: (_m: unknown, ev: Record<string, unknown>) => void sent.push(ev),
}));

const { handleClipboardAction } = await import('@/store/clipboard');

const readAction = {
  type: 'user.clipboard.read',
  id: 'r1',
  image: false,
  maxChars: 5,
  maxImagePx: 0,
  maxImageBytes: 0,
} as never;

function installHost(readText: () => Promise<string>) {
  window.yaarHost = {
    version: YAAR_HOST_VERSION,
    platform: 'macos',
    caps: ['clipboard'],
    download: async () => ({ savedTo: '' }),
    clipboard: { readText, writeText: async () => {} },
    openExternal: () => {},
    on: () => () => {},
  } as YaarHost;
}

let savedClipboard: PropertyDescriptor | undefined;
beforeEach(() => {
  sent.length = 0;
  savedClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  // A browser path that would fail loudly if reached.
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      readText: async () => {
        throw new Error('browser path used');
      },
    },
    configurable: true,
  });
});
afterEach(() => {
  delete window.yaarHost;
  if (savedClipboard) Object.defineProperty(navigator, 'clipboard', savedClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

describe('clipboard read via the host', () => {
  it('reads text through the host and applies maxChars', async () => {
    installHost(async () => 'hello world');
    await handleClipboardAction(readAction);
    expect(sent[0]).toMatchObject({
      requestId: 'r1',
      ok: true,
      text: 'hello',
      truncated: true,
      totalChars: 11,
    });
  });

  it('reports an empty clipboard', async () => {
    installHost(async () => '');
    await handleClipboardAction(readAction);
    expect(sent[0]).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('classifies a host failure', async () => {
    installHost(async () => {
      throw new Error('boom');
    });
    await handleClipboardAction(readAction);
    expect(sent[0]).toMatchObject({ ok: false, reason: 'failed', error: 'boom' });
  });

  it('keeps the browser path with no host', async () => {
    await handleClipboardAction(readAction);
    expect(sent[0]).toMatchObject({ ok: false });
    expect((sent[0] as { error?: string }).error).toContain('browser path used');
  });
});
