/**
 * `exportContent` saves through `window.yaarHost` when the native window has one (an
 * `<a download>` is a no-op in a WKWebView), and keeps the anchor path everywhere else.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { YAAR_HOST_VERSION, type YaarHost } from '@yaar/shared';
import { useDesktopStore } from '@/store';
import { exportContent } from '@/lib/exportContent';

let saved: { name: string; mime: string; bytes: ArrayBuffer }[];
let clicked: { download: string; href: string }[];
const origCreate = URL.createObjectURL;
const origRevoke = URL.revokeObjectURL;
const origClick = HTMLAnchorElement.prototype.click;

function installHost() {
  const host: YaarHost = {
    version: YAAR_HOST_VERSION,
    platform: 'macos',
    caps: ['download'],
    download: async (f) => {
      saved.push(f);
      return { savedTo: `~/Downloads/${f.name}` };
    },
    clipboard: { readText: async () => '', writeText: async () => {} },
    openExternal: () => {},
    on: () => () => {},
  };
  window.yaarHost = host;
}

beforeEach(() => {
  saved = [];
  clicked = [];
  useDesktopStore.setState({ toasts: {} });
  URL.createObjectURL = () => 'blob:fake';
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    clicked.push({ download: this.download, href: this.href });
  };
});

afterEach(() => {
  delete window.yaarHost;
  URL.createObjectURL = origCreate;
  URL.revokeObjectURL = origRevoke;
  HTMLAnchorElement.prototype.click = origClick;
});

describe('exportContent', () => {
  it('uses <a download> with no host', async () => {
    await exportContent({ renderer: 'text', data: 'hello' }, 'note');
    expect(clicked).toEqual([{ download: 'note.txt', href: 'blob:fake' }]);
    expect(saved).toHaveLength(0);
  });

  it('saves through the host, and toasts where it landed', async () => {
    installHost();
    await exportContent({ renderer: 'text', data: 'hello' }, 'a/b');
    expect(clicked).toHaveLength(0);
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('a-b.txt');
    expect(saved[0].mime).toStartWith('text/plain');
    expect(new TextDecoder().decode(saved[0].bytes)).toBe('hello');
    const messages = Object.values(useDesktopStore.getState().toasts).map((t) => t.message);
    expect(messages).toEqual(['Saved to ~/Downloads/a-b.txt']);
  });
});
