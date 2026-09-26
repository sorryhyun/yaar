/**
 * `copyText` uses the async clipboard where the page may, and falls back to
 * `execCommand('copy')` where it may not — plain http on a LAN address, remote mode's
 * usual road in from a phone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { copyText } from '@/lib/copyText';

type Writable = { writeText?: (text: string) => Promise<void> };

describe('copyText', () => {
  const g = globalThis as unknown as { isSecureContext?: boolean };
  const doc = document as Document & { execCommand: (cmd: string) => boolean };
  let savedSecure: boolean | undefined;
  let savedClipboard: PropertyDescriptor | undefined;
  let savedExec: Document['execCommand'];
  let written: string[];
  let execs: { cmd: string; selected: string }[];

  function setClipboard(value: Writable | undefined) {
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
  }

  beforeEach(() => {
    savedSecure = g.isSecureContext;
    savedClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    savedExec = doc.execCommand;
    written = [];
    execs = [];
    setClipboard({ writeText: async (text) => void written.push(text) });
    doc.execCommand = (cmd: string) => {
      const scratch = document.activeElement as HTMLTextAreaElement | null;
      execs.push({ cmd, selected: scratch?.value ?? '' });
      return true;
    };
  });

  afterEach(() => {
    g.isSecureContext = savedSecure;
    if (savedClipboard) Object.defineProperty(navigator, 'clipboard', savedClipboard);
    doc.execCommand = savedExec;
  });

  it('writes through the async clipboard in a secure context', async () => {
    g.isSecureContext = true;
    expect(await copyText('hello')).toBe(true);
    expect(written).toEqual(['hello']);
    expect(execs).toEqual([]);
  });

  it('falls back to execCommand on plain http, and leaves no textarea behind', async () => {
    g.isSecureContext = false;
    expect(await copyText('over lan')).toBe(true);
    expect(written).toEqual([]);
    expect(execs.map((e) => e.cmd)).toEqual(['copy']);
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('falls back when the async clipboard refuses', async () => {
    g.isSecureContext = true;
    setClipboard({
      writeText: async () => {
        throw new Error('NotAllowedError');
      },
    });
    expect(await copyText('x')).toBe(true);
    expect(execs.map((e) => e.cmd)).toEqual(['copy']);
  });

  it('reports failure when neither way copies', async () => {
    g.isSecureContext = false;
    doc.execCommand = () => false;
    expect(await copyText('x')).toBe(false);
  });
});
