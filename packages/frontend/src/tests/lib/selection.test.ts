import { describe, expect, it } from 'bun:test';
import { beginShellDrag } from '@/lib/selection';

describe('beginShellDrag', () => {
  it('collapses a live selection so the drag surface still deselects', () => {
    const host = document.createElement('p');
    host.textContent = 'selected content';
    document.body.append(host);

    const range = document.createRange();
    range.selectNodeContents(host);
    const selection = globalThis.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.rangeCount).toBe(1);

    beginShellDrag({ preventDefault() {} });

    expect(selection?.rangeCount).toBe(0);
    host.remove();
  });

  it('prevents the default so the drag paints no new selection', () => {
    let prevented = false;
    beginShellDrag({
      preventDefault() {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
  });
});
