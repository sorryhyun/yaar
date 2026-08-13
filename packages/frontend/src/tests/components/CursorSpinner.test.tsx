/**
 * Where the busy spinner ends up while an agent runs.
 *
 * It used to track only the desktop document's `mousemove`, so the moment the
 * cursor entered an app window — an iframe, which swallows pointer events — the
 * spinner froze at the frame's edge and sat there for as long as the agent was
 * busy. These assert the two halves of the fix: a forwarded `yaar:cursor-move`
 * moves the spinner in viewport coordinates, and a frame that forwards nothing
 * (an external site, where none of our scripts are injected) hides it rather
 * than leaving a stale one behind.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, cleanup, waitFor } from '@testing-library/react';
import { useDesktopStore } from '@/store';
import { CursorSpinner } from '@/components/overlays/CursorSpinner';

/** Matches CURSOR_OFFSET in the component. */
const OFFSET = 16;

function setAgentBusy(busy: boolean) {
  useDesktopStore.setState({
    activeAgents: busy
      ? { a1: { id: 'a1', status: 'Thinking...', startedAt: 0, subagentCount: 0 } }
      : {},
  } as never);
}

/** An app window's iframe, positioned where happy-dom would otherwise report 0,0. */
function mountWindowIframe(left: number, top: number): HTMLIFrameElement {
  const windowEl = document.createElement('div');
  windowEl.setAttribute('data-window-id', 'win-1');
  const iframe = document.createElement('iframe');
  windowEl.appendChild(iframe);
  document.body.appendChild(windowEl);
  iframe.getBoundingClientRect = () => ({ left, top }) as DOMRect;
  return iframe;
}

/**
 * The spinner's own element. Queried through the render container rather than
 * by class name: CSS-module class names are empty under bun test.
 */
let container: HTMLElement | null = null;

function renderSpinner() {
  container = render(<CursorSpinner />).container;
}

function spinnerEl(): HTMLElement | null {
  return (container?.firstElementChild as HTMLElement | null) ?? null;
}

/** The paint runs in a rAF, so the position lands a frame after the event. */
async function expectPosition(x: number, y: number) {
  const expected = `translate3d(${x + OFFSET}px, ${y + OFFSET}px, 0)`;
  await waitFor(() => expect(spinnerEl()?.style.transform).toBe(expected));
}

/** happy-dom's MessageEvent refuses a Window as `source`; the router reads it. */
function postFromFrame(iframe: HTMLIFrameElement, data: unknown) {
  const event = new window.MessageEvent('message', { data });
  Object.defineProperty(event, 'source', { value: iframe.contentWindow, writable: false });
  window.dispatchEvent(event);
}

describe('the cursor spinner', () => {
  beforeEach(() => {
    setAgentBusy(true);
  });

  afterEach(() => {
    cleanup();
    container = null;
    document.body.innerHTML = '';
    setAgentBusy(false);
  });

  it('follows the cursor across the desktop', async () => {
    renderSpinner();

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 200 }));

    await expectPosition(100, 200);
    expect(spinnerEl()?.style.opacity).toBe('1');
  });

  it('follows the cursor inside an app iframe, in viewport coordinates', async () => {
    const iframe = mountWindowIframe(300, 400);
    renderSpinner();

    // The frame reports its own local coordinates; the parent adds the frame's
    // offset back on so the spinner lands under the real cursor.
    postFromFrame(iframe, { type: 'yaar:cursor-move', clientX: 10, clientY: 20 });

    await expectPosition(310, 420);
  });

  it('hides over a frame that forwards nothing, instead of stranding itself', async () => {
    const iframe = mountWindowIframe(300, 400);
    renderSpinner();

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 200 }));
    await expectPosition(100, 200);

    // Cursor crosses into the frame — the parent's last sighting of it. No
    // `yaar:cursor-move` follows, so this frame cannot say where the cursor is.
    iframe.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    await waitFor(() => expect(spinnerEl()?.style.opacity).toBe('0'), { timeout: 2000 });
  });

  it('shows nothing when no agent is running', () => {
    setAgentBusy(false);
    renderSpinner();

    expect(spinnerEl()).toBeNull();
  });

  /**
   * A CSS animation outranks an inline style in the cascade. The first cut of
   * this component put the rAF's `translate3d` and the `spin` keyframe on one
   * element, so the rotation replaced the position 60 times a second and the
   * spinner sat at the origin — invisible to every test above, since happy-dom
   * runs no animations. Hence the two elements, asserted against the stylesheet.
   */
  it('keeps the positioned element and the animated one apart', () => {
    renderSpinner();

    const css = readFileSync(
      join(import.meta.dir, '../../styles/overlays/CursorSpinner.module.css'),
      'utf8',
    );
    const block = (name: string) => css.match(new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

    expect(block('host')).not.toContain('animation');
    expect(block('spinner')).toContain('animation');
    expect(spinnerEl()?.firstElementChild).not.toBeNull();
  });
});
