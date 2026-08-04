/**
 * `yaar://user/clipboard` — what the agent is told, for each thing the desktop can say.
 *
 * The round trip itself (the answer overtaking the turn that is parked on it) is covered
 * by the loopback row in `loopback/loopback-answer-waits.test.ts`. What is covered here is
 * the layer above: the clipboard is read through a browser that can refuse in four
 * different ways, and every one of them used to be the caller's problem to guess at. An
 * agent that cannot tell "you have not granted clipboard access" from "click the desktop
 * first" from "the clipboard is empty" will tell the user the wrong thing, confidently.
 *
 * The desktop is faked at the emitter's `'user-clipboard'` channel — the same seam
 * `LiveSession` subscribes to — so everything from `readClipboard()` down through the
 * pending store is the real code.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { readFile, rm } from 'fs/promises';
import { join } from 'path';
import { ServerEventType, type UserClipboardAction } from '@yaar/shared';
import { actionEmitter, type ClipboardFeedback } from '../session/action-emitter.js';
import type { SessionScopedEvent } from '../session/emitter-channels.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import type { SessionId } from '../session/types.js';
// `STORAGE_DIR` is resolved once at module load, so a test cannot move it by setting
// YAAR_STORAGE mid-run. It is already a fresh temp dir — `scripts/test/env.ts` points it
// at one for every run — so a save test writes there and reads it back.
import { STORAGE_DIR, setDeadlinesForTest } from '../config.js';
import {
  readClipboard,
  saveClipboard,
  writeClipboard,
  CLIPBOARD_TEXT_LIMIT,
  CLIPBOARD_IMAGE_MAX_PX,
} from '../features/user/clipboard.js';

/** A 1×1 PNG — real bytes, so a save writes a file that is actually a PNG. */
const PNG_1PX_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let stopDesktop: (() => void) | undefined;
let restoreDeadlines: (() => void) | undefined;

afterEach(() => {
  stopDesktop?.();
  stopDesktop = undefined;
  restoreDeadlines?.();
  restoreDeadlines = undefined;
});

/**
 * Stand in for the browser: answer every clipboard action with what `reply` returns, and
 * record the actions themselves so a test can assert on the ceilings that were sent.
 */
function fakeDesktop(
  reply: (action: UserClipboardAction) => Omit<ClipboardFeedback, 'requestId'>,
): UserClipboardAction[] {
  const seen: UserClipboardAction[] = [];
  const handler = (data: SessionScopedEvent) => {
    if (data.event.type !== ServerEventType.ACTIONS) return;
    for (const action of data.event.actions) {
      if (!action.type.startsWith('user.clipboard.')) continue;
      const clipboardAction = action as UserClipboardAction;
      seen.push(clipboardAction);
      // Answer on a later tick, as a socket would — the pending entry must already exist.
      queueMicrotask(() =>
        actionEmitter.resolveClipboardFeedback({
          requestId: clipboardAction.id,
          ...reply(clipboardAction),
        }),
      );
    }
  };
  actionEmitter.on('user-clipboard', handler);
  stopDesktop = () => actionEmitter.off('user-clipboard', handler);
  return seen;
}

/** Run inside an agent context, which is where the emitter reads the session id from. */
function asAgent<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  return runWithAgentContext({ agentId: 'monitor:0', sessionId: sessionId as SessionId }, fn);
}

describe('yaar://user/clipboard — read', () => {
  it('sends the ceilings with the request rather than trimming after the fact', async () => {
    const seen = fakeDesktop(() => ({ ok: true, text: 'hi' }));

    await asAgent('sess-limits', () => readClipboard());

    const read = seen[0]!;
    expect(read.type).toBe('user.clipboard.read');
    // The whole point of naming the ceilings in the action: a 30 MB screenshot is trimmed
    // at the source, not after it has crossed a WebSocket frame.
    expect(read).toMatchObject({
      maxChars: CLIPBOARD_TEXT_LIMIT,
      image: true,
      maxImagePx: CLIPBOARD_IMAGE_MAX_PX,
    });
  });

  it('reports the true length when the desktop truncated', async () => {
    fakeDesktop(() => ({ ok: true, text: 'x'.repeat(10), truncated: true, totalChars: 900_000 }));

    const result = await asAgent('sess-trunc', () => readClipboard());

    expect(result.success).toBe(true);
    expect(result.truncated).toBe(true);
    // Without the true length, "truncated" tells the reader nothing actionable: it cannot
    // tell 10 missing characters from 900,000, and so cannot tell whether to go to `save`.
    expect(result.totalChars).toBe(900_000);
  });

  it('carries an image through with its natural size, not the thumbnail’s', async () => {
    fakeDesktop(() => ({
      ok: true,
      image: {
        data: PNG_1PX_BASE64,
        mimeType: 'image/webp',
        bytes: 4096,
        width: 3840,
        height: 2160,
        downscaled: true,
      },
    }));

    const result = await asAgent('sess-image', () => readClipboard());

    expect(result.success).toBe(true);
    expect(result.image?.width).toBe(3840);
    expect(result.image?.downscaled).toBe(true);
  });
});

describe('yaar://user/clipboard — the four ways a browser says no', () => {
  const cases = [
    { reason: 'denied' as const, mentions: /permission/i },
    { reason: 'not-focused' as const, mentions: /focus|click/i },
    { reason: 'unsupported' as const, mentions: /paste/i },
    { reason: 'empty' as const, mentions: /empty/i },
    { reason: 'too-large' as const, mentions: /save/i },
  ];

  for (const { reason, mentions } of cases) {
    it(`"${reason}" is explained in terms of what to do about it`, async () => {
      fakeDesktop(() => ({ ok: false, reason }));

      const result = await asAgent(`sess-${reason}`, () => readClipboard());

      expect(result.success).toBe(false);
      // Each failure names its own fix. Collapsed into one message, an agent reports a
      // permission problem to a user whose tab was merely unfocused.
      expect(result.error).toMatch(mentions);
    });
  }

  it('distinguishes a deadline from an empty clipboard', async () => {
    restoreDeadlines = setDeadlinesForTest({ clipboardMs: 20 });
    // No desktop attached: nothing answers, and the wait expires.
    const result = await asAgent('sess-silent', () => readClipboard());

    expect(result.success).toBe(false);
    // "The clipboard is empty" would be a factual claim about the user's machine that
    // nothing here observed — and it is what the agent would repeat to the user.
    expect(result.error).not.toMatch(/empty/i);
    expect(result.error).toMatch(/did not answer/i);
  });

  it('fails immediately when there is no session to ask', async () => {
    // Outside an agent context there is no desktop to address. This must not park for the
    // full deadline before saying so.
    const started = Date.now();
    const result = await readClipboard();

    expect(result.success).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('yaar://user/clipboard — write and save', () => {
  it('write reports the browser’s refusal rather than claiming success', async () => {
    fakeDesktop(() => ({ ok: false, reason: 'denied' }));

    const result = await asAgent('sess-write-denied', () => writeClipboard('hello'));

    expect(result.success).toBe(false);
  });

  it('save asks for the clipboard at full fidelity, unlike read', async () => {
    const seen = fakeDesktop(() => ({ ok: true, text: 'whatever' }));

    try {
      await asAgent('sess-save-limits', () => saveClipboard('temp/paste.txt'));
      const read = seen[0] as Extract<UserClipboardAction, { type: 'user.clipboard.read' }>;
      // `read` is sized for a conversation; `save` is sized for a disk. Sharing one ceiling
      // would make `save` — the documented escape hatch from truncation — truncate too.
      expect(read.maxChars).toBeGreaterThan(CLIPBOARD_TEXT_LIMIT);
      expect(read.maxImagePx).toBe(0); // no downscale: full resolution to the file
    } finally {
      await rm(join(STORAGE_DIR, 'temp/paste.txt'), { force: true });
    }
  });

  it('saves an image over the text that came with it, and picks the extension itself', async () => {
    fakeDesktop(() => ({
      ok: true,
      // A screenshot pasted from a design tool: an image plus a text/plain filename.
      text: 'Screenshot 2026-08-02.png',
      image: {
        data: PNG_1PX_BASE64,
        mimeType: 'image/png',
        bytes: 68,
        width: 1,
        height: 1,
      },
    }));

    try {
      const result = await asAgent('sess-save-image', () => saveClipboard('temp/shot'));

      expect(result.success).toBe(true);
      // Saving the text alternative would have written a file containing the *name* of the
      // screenshot and reported success — the wrong thing, indistinguishably.
      expect(result.uri).toBe('yaar://storage/temp/shot.png');
      expect(result.kind).toBe('image/png');

      const written = await readFile(join(STORAGE_DIR, 'temp/shot.png'));
      expect(written.subarray(1, 4).toString('latin1')).toBe('PNG');
    } finally {
      await rm(join(STORAGE_DIR, 'temp/shot.png'), { force: true });
    }
  });
});

/**
 * The credential scan (`features/user/secret-scan.ts`) lives below both doors. What the unit
 * tests cannot show is the thing that decided where to put it: `read` and `save` are two ways
 * to the same bytes, and a guard on one of them is not a guard.
 */
describe('yaar://user/clipboard — credentials', () => {
  const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
  const ENV_PASTE = `AWS_ACCESS_KEY_ID=${AWS_KEY}\nAWS_REGION=us-east-1`;

  it('read hands over the paste with the credential replaced', async () => {
    fakeDesktop(() => ({ ok: true, text: ENV_PASTE }));

    const result = await asAgent('sess-secret-read', () => readClipboard());

    expect(result.success).toBe(true);
    expect(result.text).not.toContain(AWS_KEY);
    // Redaction, not refusal: the rest of the paste is why the agent was asked to look.
    expect(result.text).toContain('AWS_REGION=us-east-1');
    expect(result.redactions).toEqual([{ kind: 'aws-access-key-id', count: 1 }]);
  });

  it('save writes the redacted text, not the raw clipboard', async () => {
    fakeDesktop(() => ({ ok: true, text: ENV_PASTE }));

    try {
      const result = await asAgent('sess-secret-save', () => saveClipboard('temp/env.txt'));

      expect(result.success).toBe(true);
      expect(result.redactions).toEqual([{ kind: 'aws-access-key-id', count: 1 }]);

      // The bypass this closes: `save` returns a URI rather than bytes, so a raw write would
      // look like it had kept the key out of the conversation while leaving it one
      // `read('yaar://storage/temp/env.txt')` away — a read with no clipboard in it to scan.
      const written = await readFile(join(STORAGE_DIR, 'temp/env.txt'), 'utf8');
      expect(written).not.toContain(AWS_KEY);
      expect(written).toContain('AWS_REGION=us-east-1');
      // `bytes` describes the file that exists, not the clipboard that was read.
      expect(result.bytes).toBe(Buffer.byteLength(written, 'utf8'));
    } finally {
      await rm(join(STORAGE_DIR, 'temp/env.txt'), { force: true });
    }
  });

  it('says nothing about redaction when the clipboard holds no credentials', async () => {
    fakeDesktop(() => ({ ok: true, text: 'the meeting is at four' }));

    const result = await asAgent('sess-secret-clean', () => readClipboard());

    // Absent rather than empty: a caller must not have to tell "scanned, clean" from
    // "not scanned" to decide whether to render a warning.
    expect(result.redactions).toBeUndefined();
    expect(result.text).toBe('the meeting is at four');
  });

  it('YAAR_CLIPBOARD_SECRETS=0 hands the clipboard over untouched', async () => {
    fakeDesktop(() => ({ ok: true, text: ENV_PASTE }));
    process.env.YAAR_CLIPBOARD_SECRETS = '0';
    try {
      const result = await asAgent('sess-secret-off', () => readClipboard());

      // Read per call, not at module load — otherwise the opt-out is a launch flag and the
      // test below would pass for the wrong reason.
      expect(result.text).toContain(AWS_KEY);
      expect(result.redactions).toBeUndefined();
    } finally {
      delete process.env.YAAR_CLIPBOARD_SECRETS;
    }
  });
});
