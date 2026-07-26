/**
 * Both screenshot pipelines render a `cloneNode(true)` of the document through a
 * foreignObject-as-image. cloneNode copies *attributes*, not IDL properties, so
 * a field whose value was assigned in JS (`input.value = x`, or a Solid/React
 * `value=` binding — both property writes) serialized with its default: apps
 * screenshotted as a form of empty boxes while the live DOM was populated, and
 * an agent looking at the capture would report a rendering bug that isn't there.
 *
 * There are two copies of the fix — the frontend's monitor capture (TS) and the
 * iframe self-capture (an injected ES5 string that cannot import it) — so both
 * are pinned here. The ES5 one is lifted out of the shipped script rather than
 * re-declared, so the test tracks the code that actually runs.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { IFRAME_CAPTURE_HELPER_SCRIPT } from '@yaar/shared';
import { inlineFormState as frontendInlineFormState } from '@/lib/captureMonitorScreenshot';

type InlineFormState = (clone: HTMLElement, original: HTMLElement) => void;

/** The real `inlineFormState` as it ships inside the injected capture script. */
function shippedInlineFormState(): InlineFormState {
  const start = IFRAME_CAPTURE_HELPER_SCRIPT.indexOf('function inlineFormState(');
  if (start === -1)
    throw new Error('inlineFormState not found in capture script — did it move or get renamed?');
  // Brace-count to the end of the declaration so the extraction can't drift with
  // whatever happens to follow it in the file.
  let depth = 0;
  let end = -1;
  for (
    let i = IFRAME_CAPTURE_HELPER_SCRIPT.indexOf('{', start);
    i < IFRAME_CAPTURE_HELPER_SCRIPT.length;
    i++
  ) {
    const ch = IFRAME_CAPTURE_HELPER_SCRIPT[i];
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end === -1) throw new Error('inlineFormState declaration is unbalanced');
  const src = IFRAME_CAPTURE_HELPER_SCRIPT.slice(start, end);
  return new Function(`return (${src})`)() as InlineFormState;
}

const IMPLEMENTATIONS: Array<[string, InlineFormState]> = [
  ['monitor capture (frontend)', frontendInlineFormState],
  ['iframe self-capture (injected script)', shippedInlineFormState()],
];

describe.each(IMPLEMENTATIONS)('inlineFormState — %s', (_name, inlineFormState) => {
  let root: HTMLElement;

  /** Clone the way the capture pipeline does, run the pass, return the clone. */
  function captureClone(): HTMLElement {
    const clone = root.cloneNode(true) as HTMLElement;
    inlineFormState(clone, root);
    return clone;
  }

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    root = document.getElementById('root') as HTMLElement;
  });

  it('carries a JS-assigned input value into the clone (the reported bug)', () => {
    root.innerHTML = '<input class="host" />';
    // No value attribute — exactly what a framework `value=` binding leaves behind.
    (root.querySelector('.host') as HTMLInputElement).value = '127.0.0.1';

    const before = root.cloneNode(true) as HTMLElement;
    expect(before.querySelector('.host')?.getAttribute('value')).toBeNull();

    expect(captureClone().querySelector('.host')?.getAttribute('value')).toBe('127.0.0.1');
  });

  it('overwrites a stale default value with the live one', () => {
    root.innerHTML = '<input value="3000" />';
    (root.querySelector('input') as HTMLInputElement).value = '9000';

    expect(captureClone().querySelector('input')?.getAttribute('value')).toBe('9000');
  });

  it('serializes an empty input as empty rather than keeping the default', () => {
    root.innerHTML = '<input value="placeholder-ish" />';
    (root.querySelector('input') as HTMLInputElement).value = '';

    expect(captureClone().querySelector('input')?.getAttribute('value')).toBe('');
  });

  it('carries textarea text, which lives in the child node and not an attribute', () => {
    root.innerHTML = '<textarea></textarea>';
    (root.querySelector('textarea') as HTMLTextAreaElement).value = 'line one\nline two';

    expect(captureClone().querySelector('textarea')?.textContent).toBe('line one\nline two');
  });

  it('reflects checked state in both directions', () => {
    root.innerHTML =
      '<input type="checkbox" class="on" /><input type="checkbox" class="off" checked />';
    (root.querySelector('.on') as HTMLInputElement).checked = true;
    (root.querySelector('.off') as HTMLInputElement).checked = false;

    const clone = captureClone();
    expect(clone.querySelector('.on')?.hasAttribute('checked')).toBe(true);
    expect(clone.querySelector('.off')?.hasAttribute('checked')).toBe(false);
  });

  it('reflects which option a select is showing', () => {
    root.innerHTML =
      '<select><option value="http">http</option><option value="stdio">stdio</option></select>';
    (root.querySelector('select') as HTMLSelectElement).value = 'stdio';

    const options = captureClone().querySelectorAll('option');
    expect(options[0].hasAttribute('selected')).toBe(false);
    expect(options[1].hasAttribute('selected')).toBe(true);
  });

  it('masks a password to the same length instead of serializing the secret', () => {
    root.innerHTML = '<input type="password" />';
    (root.querySelector('input') as HTMLInputElement).value = 'hunter2';

    const value = captureClone().querySelector('input')?.getAttribute('value');
    expect(value).toBe('•••••••');
    expect(value).not.toContain('hunter2');
  });

  it('leaves a file input alone (its value is not settable)', () => {
    root.innerHTML = '<input type="file" />';

    expect(captureClone().querySelector('input')?.hasAttribute('value')).toBe(false);
  });

  it('pairs elements by index across a mixed tree', () => {
    root.innerHTML =
      '<input class="a" /><div><textarea class="b"></textarea><input class="c" /></div>';
    (root.querySelector('.a') as HTMLInputElement).value = 'A';
    (root.querySelector('.b') as HTMLTextAreaElement).value = 'B';
    (root.querySelector('.c') as HTMLInputElement).value = 'C';

    const clone = captureClone();
    expect(clone.querySelector('.a')?.getAttribute('value')).toBe('A');
    expect(clone.querySelector('.b')?.textContent).toBe('B');
    expect(clone.querySelector('.c')?.getAttribute('value')).toBe('C');
  });
});
