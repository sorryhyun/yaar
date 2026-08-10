/**
 * A capture that succeeds while omitting content has to say so.
 *
 * The composite screenshot is a reconstruction, and when it fails the script can
 * still rescue pixels by returning the largest `<canvas>` alone. That rescue used
 * to go out as an ordinary success with the failure reason dropped on the floor —
 * so a screenshot taken to check a region came back showing one canvas, none of
 * the surrounding DOM, and nothing marking it as partial. An agent looking at the
 * empty region concluded the app had rendered nothing there.
 *
 * Both halves of the contract are pinned here, lifted out of the shipped script
 * rather than re-declared (same approach as capture-xml-scrub.test.ts) so the test
 * tracks the code that actually runs:
 *   - a rescued image goes out labelled, never bare
 *   - a rescue that finds no pixels goes out as the failure it is
 */
import { describe, it, expect } from 'bun:test';
import { IFRAME_CAPTURE_HELPER_SCRIPT } from '@yaar/shared';

/** Lift one top-level `function name(...) {...}` declaration out of the script. */
function extract(name: string): string {
  const start = IFRAME_CAPTURE_HELPER_SCRIPT.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in capture script — renamed or removed?`);
  let depth = 0;
  for (
    let i = IFRAME_CAPTURE_HELPER_SCRIPT.indexOf('{', start);
    i < IFRAME_CAPTURE_HELPER_SCRIPT.length;
    i++
  ) {
    const ch = IFRAME_CAPTURE_HELPER_SCRIPT[i];
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      return IFRAME_CAPTURE_HELPER_SCRIPT.slice(start, i + 1);
    }
  }
  throw new Error(`${name} declaration is unbalanced`);
}

interface Posted {
  imageData: string | null;
  reason?: string;
  degraded?: string[];
}

/** The real `respond`, wired to a fake parent window that records what it posted. */
function shippedRespond() {
  const posted: Posted[] = [];
  const windowShim = { parent: { postMessage: (msg: Posted) => void posted.push(msg) } };
  const fn = new Function('window', `${extract('respond')}; return respond;`)(windowShim) as (
    requestId: string,
    imageData: string | null,
    reason?: string,
    degraded?: string[],
  ) => void;
  return { respond: fn, posted };
}

/** The real `respondWithFallback`, with its two collaborators injected. */
function shippedRespondWithFallback(canvasPixels: string | null) {
  const { respond, posted } = shippedRespond();
  const fn = new Function(
    'respond',
    'largestCanvasCapture',
    `${extract('respondWithFallback')}; return respondWithFallback;`,
  )(respond, () => canvasPixels) as (requestId: string, reason: string, notes?: string[]) => void;
  return { respondWithFallback: fn, posted };
}

describe('capture response — degraded successes', () => {
  it('attaches degraded notes to a success', () => {
    const { respond, posted } = shippedRespond();
    respond('req-1', 'data:image/webp;base64,AAA', undefined, ['2 <canvas> came back blank']);
    expect(posted[0]?.imageData).toBe('data:image/webp;base64,AAA');
    expect(posted[0]?.reason).toBeUndefined();
    expect(posted[0]?.degraded).toEqual(['2 <canvas> came back blank']);
  });

  it('leaves an unqualified success unchanged', () => {
    const { respond, posted } = shippedRespond();
    respond('req-2', 'data:image/webp;base64,AAA', undefined, []);
    expect(posted[0]?.degraded).toBeUndefined();
    expect(posted[0]?.reason).toBeUndefined();
  });

  it('never attaches degraded notes to a failure — a null carries a reason instead', () => {
    const { respond, posted } = shippedRespond();
    respond('req-3', null, 'taint', ['something']);
    expect(posted[0]?.imageData).toBeNull();
    expect(posted[0]?.reason).toBe('taint');
    expect(posted[0]?.degraded).toBeUndefined();
  });
});

describe('capture response — largest-canvas rescue', () => {
  it('labels a rescued image with the failure it is standing in for', () => {
    const { respondWithFallback, posted } = shippedRespondWithFallback('data:image/png;base64,ZZZ');
    respondWithFallback('req-4', 'img-load-error', []);

    // The pixels arrive — this is still a success, not an error.
    expect(posted[0]?.imageData).toBe('data:image/png;base64,ZZZ');
    // ...but never bare: the label is what stops the missing DOM from reading as
    // an app that drew nothing.
    const notes = posted[0]?.degraded ?? [];
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('fallback:largest-canvas');
    expect(notes[0]).toContain('img-load-error');
  });

  it('keeps the notes the composite had already accumulated', () => {
    const { respondWithFallback, posted } = shippedRespondWithFallback('data:image/png;base64,ZZZ');
    respondWithFallback('req-5', 'serialize-error', ['3 <img> element(s) could not be inlined']);

    const notes = posted[0]?.degraded ?? [];
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain('could not be inlined');
    expect(notes[1]).toContain('fallback:largest-canvas');
  });

  it('reports the original failure when the rescue finds no pixels', () => {
    const { respondWithFallback, posted } = shippedRespondWithFallback(null);
    respondWithFallback('req-6', 'taint', ['a note nobody will read']);

    // No image means the reason is the answer, and it must be the *composite's*
    // reason — the fallback's own emptiness is not the diagnosis.
    expect(posted[0]?.imageData).toBeNull();
    expect(posted[0]?.reason).toBe('taint');
    expect(posted[0]?.degraded).toBeUndefined();
  });
});
