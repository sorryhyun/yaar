import { beforeEach, describe, expect, test } from 'bun:test';
import * as z from 'zod/mini';

/**
 * The Part 1 micro-helpers: each one replaced 4-15 hand-rolled copies, and what
 * is worth pinning is the behavior those copies disagreed about — whether a
 * missing value is a failure, whether a `"` is escaped, how many decimals a
 * megabyte gets. The mechanics (a `<a download>` click, a `FileReader`) are
 * tested only where a copy got them wrong.
 *
 * Globals are stubbed by hand rather than through happy-dom: the surface these
 * touch is a handful of methods, and `sanitize.js` is deliberately imported for
 * `escapeHtml` alone — DOMPurify under a synthetic DOM is its own known mess.
 */

interface FakeAnchor {
  tag: string;
  href: string;
  download: string;
  style: Record<string, string>;
  clicked: number;
  attached: boolean;
  click(): void;
  remove(): void;
}

const anchors: FakeAnchor[] = [];
const revoked: string[] = [];
const toasts: { className: string; textContent: string }[] = [];
const errors: string[] = [];

function makeAnchor(tag: string): FakeAnchor {
  const el: FakeAnchor = {
    tag,
    href: '',
    download: '',
    style: {},
    clicked: 0,
    attached: false,
    click: () => void el.clicked++,
    remove: () => void (el.attached = false),
  };
  return el;
}

(globalThis as any).document = {
  body: {
    appendChild: (el: any) => {
      el.attached = true;
      if (el.className !== undefined) toasts.push(el);
      return el;
    },
  },
  createElement: (tag: string) => {
    if (tag === 'a') {
      const a = makeAnchor(tag);
      anchors.push(a);
      return a;
    }
    return {
      tag,
      className: '',
      textContent: '',
      classList: { add() {}, remove() {} },
      remove() {},
    };
  },
};
(globalThis as any).requestAnimationFrame = (cb: () => void) => {
  cb();
  return 0;
};
// The two statics only — never `globalThis.URL` itself. Replacing the whole binding
// takes the *constructor* with it, and these stubs outlive the file: the compiler's
// `readLinkConfig` does `new URL(base)` inside a catch-all, so every later test file in
// this process silently read app.json's `links` as `{}` and reported a green compile.
const objectUrls = URL as unknown as {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
};
objectUrls.createObjectURL = () => 'blob:fake-url';
objectUrls.revokeObjectURL = (url: string) => void revoked.push(url);

/** Bun has no `FileReader`; this is the two events `blobToDataUrl` listens for. */
class FakeFileReader {
  result: string | null = null;
  error: unknown = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: Blob) {
    blob
      .arrayBuffer()
      .then((buf) => {
        const base64 = Buffer.from(buf).toString('base64');
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${base64}`;
        this.onload?.();
      })
      .catch((e) => {
        this.error = e;
        this.onerror?.();
      });
  }
}
(globalThis as any).FileReader = FakeFileReader;

const originalError = console.error;
console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
process.on('exit', () => {
  console.error = originalError;
});

const { safeParseOr } = await import('../shims/yaar/boundary.js');
const { tryToast } = await import('../shims/yaar/ui.js');
const { escapeHtml } = await import('../shims/yaar/sanitize.js');
const { downloadBlob, blobToDataUrl, dataUrlToBlob, base64ToBytes } =
  await import('../shims/yaar/files.js');
const { base64FromBuffer: bytesToBase64 } = await import('../shims/yaar/image.js');
const { formatBytes, formatClock, formatDuration } = await import('../shims/yaar/format.js');

beforeEach(() => {
  anchors.length = 0;
  revoked.length = 0;
  toasts.length = 0;
  errors.length = 0;
});

describe('safeParseOr', () => {
  const Layout = z.object({ width: z.number(), pinned: z._default(z.boolean(), false) });
  const fallback = { width: 320, pinned: false };

  test('returns the parsed value, with the schema defaults applied', () => {
    expect(safeParseOr(Layout, { width: 480 }, fallback)).toEqual({ width: 480, pinned: false });
    expect(errors).toBeEmpty();
  });

  test('falls back and logs the issues when the value is present but wrong', () => {
    expect(safeParseOr(Layout, { width: 'wide' }, fallback, { label: 'storage:layout' })).toBe(
      fallback,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('safeParseOr(storage:layout)');
    expect(errors[0]).toContain('width');
  });

  test('an absent value is not a failure — fallback, no log', () => {
    expect(safeParseOr(Layout, undefined, fallback)).toBe(fallback);
    expect(errors).toBeEmpty();
  });

  test('null is data, not absence — it is parsed and reported', () => {
    expect(safeParseOr(Layout, null, fallback)).toBe(fallback);
    expect(errors).toHaveLength(1);
  });

  test('a fallback of another type widens the result rather than being rejected', () => {
    expect(safeParseOr(Layout, { width: 'wide' }, null)).toBeNull();
  });

  test('onInvalid replaces the log rather than adding to it', () => {
    const seen: unknown[] = [];
    const out = safeParseOr(Layout, { width: 'wide' }, fallback, {
      onInvalid: (issues) => seen.push(issues),
    });
    expect(out).toBe(fallback);
    expect(seen).toHaveLength(1);
    // The schema's own issues, so a caller can log or render them itself.
    expect(Array.isArray(seen[0])).toBeTrue();
    expect(errors).toBeEmpty();
  });

  test('onInvalid does not run for an absent value', () => {
    let called = false;
    expect(safeParseOr(Layout, undefined, fallback, { onInvalid: () => (called = true) })).toBe(
      fallback,
    );
    expect(called).toBeFalse();
  });

  test('an onInvalid that throws reaches the caller — parse-or-throw, without a second export', () => {
    expect(() =>
      safeParseOr(Layout, { width: 'wide' }, undefined, {
        onInvalid: () => {
          throw new Error('Malformed config');
        },
      }),
    ).toThrow(/Malformed config/);
    expect(errors).toBeEmpty();
  });

  test('throws on a non-schema — a caller bug, not bad data', () => {
    expect(() => safeParseOr({ width: Number } as never, {}, fallback)).toThrow(/Standard Schema/);
  });

  test('throws on an async schema rather than returning a promise', () => {
    const asyncSchema = {
      '~standard': { validate: async () => ({ value: 1 }) },
    };
    expect(() => safeParseOr(asyncSchema as never, 1, fallback)).toThrow(/asynchronously/);
  });
});

describe('tryToast', () => {
  test('returns the value and stays quiet on success', async () => {
    expect(await tryToast(async () => 42)).toBe(42);
    expect(toasts).toBeEmpty();
    expect(errors).toBeEmpty();
  });

  test('toasts the success message when one is given', async () => {
    await tryToast(async () => 42, { success: 'Saved' });
    expect(toasts).toHaveLength(1);
    expect(toasts[0].textContent).toBe('Saved');
    expect(toasts[0].className).toContain('y-toast-success');
  });

  test('a throw becomes undefined, an error toast, and a logged stack', async () => {
    expect(await tryToast(async () => Promise.reject(new Error('disk full')))).toBeUndefined();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].textContent).toBe('disk full');
    expect(toasts[0].className).toContain('y-toast-error');
    expect(errors).toHaveLength(1);
  });

  test('no success toast fires when the action failed', async () => {
    await tryToast(
      async () => {
        throw new Error('nope');
      },
      { success: 'Saved' },
    );
    expect(toasts).toHaveLength(1);
    expect(toasts[0].className).toContain('y-toast-error');
  });
});

describe('escapeHtml', () => {
  test('covers the attribute context, not just the text one', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  test('leaves text with nothing to escape untouched', () => {
    expect(escapeHtml('plain text 100% fine')).toBe('plain text 100% fine');
  });

  test('escapes the ampersand first, so entities are not double-decoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('downloadBlob', () => {
  test('names the file, clicks a real anchor, and revokes after the click', async () => {
    downloadBlob(new Blob(['hi']), 'notes.txt');
    expect(anchors).toHaveLength(1);
    expect(anchors[0].href).toBe('blob:fake-url');
    expect(anchors[0].download).toBe('notes.txt');
    expect(anchors[0].clicked).toBe(1);
    // Revoking in the same tick races the download the click scheduled.
    expect(revoked).toBeEmpty();
    await new Promise((r) => setTimeout(r, 0));
    expect(revoked).toEqual(['blob:fake-url']);
  });
});

describe('blobToDataUrl', () => {
  test('reads a blob into a data: URL carrying its MIME type', async () => {
    const url = await blobToDataUrl(new Blob(['hi'], { type: 'text/plain' }));
    expect(url.startsWith('data:text/plain')).toBe(true);
    expect(url).toContain(';base64,');
    expect(atob(url.split(',')[1])).toBe('hi');
  });
});

describe('dataUrlToBlob', () => {
  test('a base64 data URL comes back with its bytes and declared MIME', async () => {
    const blob = dataUrlToBlob('data:text/plain;base64,aGk=');
    // Bun's Blob appends `;charset=utf-8` to a text/* type on its own.
    expect(blob.type.startsWith('text/plain')).toBe(true);
    expect(await blob.text()).toBe('hi');
  });

  test('the percent-encoded form decodes too, and no MIME means octet-stream', async () => {
    const blob = dataUrlToBlob('data:,a%20b');
    expect(blob.type).toBe('application/octet-stream');
    expect(await blob.text()).toBe('a b');
  });

  test('a charset parameter does not hide the base64 marker', async () => {
    const blob = dataUrlToBlob('data:text/plain;charset=utf-8;base64,aGk=');
    expect(blob.type.startsWith('text/plain')).toBe(true);
    expect(await blob.text()).toBe('hi');
  });

  test('round-trips blobToDataUrl', async () => {
    const original = new Blob([new Uint8Array([0, 255, 128])], { type: 'image/png' });
    const back = dataUrlToBlob(await blobToDataUrl(original));
    expect(back.type).toBe('image/png');
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128]));
  });

  test('throws on a string that is not a data URL — the caller decides about null', () => {
    expect(() => dataUrlToBlob('https://example.com/a.png')).toThrow(/data: URL/);
    expect(() => dataUrlToBlob('')).toThrow(/data: URL/);
  });
});

describe('base64ToBytes / bytesToBase64', () => {
  test('decodes, and tolerates the column wrapping GitHub applies', () => {
    expect(base64ToBytes('aGk=')).toEqual(new Uint8Array([104, 105]));
    expect(base64ToBytes('aG\nVs\nbG8=\n')).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
    expect(new TextDecoder().decode(base64ToBytes('7ZWc'))).toBe('한');
  });

  test('throws on malformed input rather than returning garbage', () => {
    expect(() => base64ToBytes('not base64!')).toThrow();
  });

  test('bytesToBase64 is the inverse, for a Uint8Array or an ArrayBuffer, past the chunk size', () => {
    const big = new Uint8Array(0x8000 * 3 + 7);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
    expect(bytesToBase64(big.buffer)).toBe(bytesToBase64(big));
  });
});

describe('formatBytes', () => {
  test('one ladder, one rounding rule', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(834)).toBe('834 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(formatBytes(3.3 * 1024 * 1024)).toBe('3.3 MB');
  });

  test('a size that is not a number reads as zero, never NaN', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
  });
});

describe('formatDuration', () => {
  test('hours appear only when there are hours', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(7)).toBe('0:07');
    expect(formatDuration(187)).toBe('3:07');
    expect(formatDuration(3787)).toBe('1:03:07');
  });

  test('floors rather than rounds, so a scrubber never overshoots the media', () => {
    expect(formatDuration(9.9)).toBe('0:09');
  });
});

describe('formatClock', () => {
  const at = new Date(2024, 0, 5, 15, 4, 5);

  test('24-hour, with seconds by default', () => {
    expect(formatClock(at)).toBe('15:04:05');
    expect(formatClock(at.getTime())).toBe('15:04:05');
  });

  test('drops seconds on request, for a "Saved 15:04" label', () => {
    expect(formatClock(at, { seconds: false })).toBe('15:04');
  });

  test('an unusable timestamp reads as blank, not "Invalid Date"', () => {
    expect(formatClock(Number.NaN)).toBe('--:--');
  });
});
