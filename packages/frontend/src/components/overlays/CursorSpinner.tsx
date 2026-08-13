/**
 * CursorSpinner - Small spinner that follows the cursor when AI is thinking.
 *
 * Two things keep it pinned to the cursor rather than trailing or stranded:
 *
 * 1. **Position is applied imperatively** — a ref, one rAF, and a `transform`.
 *    A `setState` per `mousemove` queues behind the store churn of a streaming
 *    agent, which is exactly when this spinner is on screen, and the spinner
 *    visibly lags the cursor.
 * 2. **Iframes are asked where the cursor is.** Pointer events do not cross a
 *    frame boundary, so the parent's last sighting of the cursor is the frame's
 *    edge — the spinner used to park there for as long as the pointer was
 *    inside an app window, which is most of the time an agent is busy. App
 *    frames forward their own pointer position (`yaar:cursor-move`,
 *    `iframe-scripts/contextmenu.ts`) and we translate it back to viewport
 *    coordinates.
 *
 * A frame that *cannot* forward — an external site in the Browser app, where
 * none of our scripts are injected — is caught by the `mouseover` the parent
 * still gets on the `<iframe>` element itself: if nothing has been forwarded
 * shortly after entering, the spinner hides instead of leaving a stale one at
 * the boundary.
 *
 * Tracking runs whether or not a spinner is on screen, so it appears at the
 * cursor the moment an agent starts instead of on the next mouse move.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useDesktopStore } from '@/store';
import { iframeMessages } from '@/lib/iframeMessageRouter';
import styles from '@/styles/overlays/CursorSpinner.module.css';

/** Drawn down-right of the hotspot, clear of the cursor itself. */
const CURSOR_OFFSET = 16;

/**
 * How long a frame has to forward a position after the cursor enters it before
 * we treat it as one that never will. Entering a frame fires a `pointermove`
 * inside it right away, so a forwarding app answers within a frame or two.
 */
const FRAME_SILENCE_MS = 300;

export function CursorSpinner() {
  const hasActiveAgents = useDesktopStore((s) => Object.keys(s.activeAgents).length > 0);

  const elRef = useRef<HTMLDivElement>(null);
  const posRef = useRef({ x: 0, y: 0 });
  /** Whether `posRef` is where the cursor actually is, not where we last saw it. */
  const knownRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const silenceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const paint = useCallback(() => {
    rafRef.current = null;
    const el = elRef.current;
    if (!el) return;
    const { x, y } = posRef.current;
    el.style.transform = `translate3d(${x + CURSOR_OFFSET}px, ${y + CURSOR_OFFSET}px, 0)`;
    el.style.opacity = knownRef.current ? '1' : '0';
  }, []);

  const schedulePaint = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(paint);
  }, [paint]);

  useEffect(() => {
    const clearSilenceTimer = () => {
      if (silenceRef.current === null) return;
      clearTimeout(silenceRef.current);
      silenceRef.current = null;
    };

    const moveTo = (x: number, y: number) => {
      posRef.current = { x, y };
      knownRef.current = true;
      clearSilenceTimer();
      schedulePaint();
    };

    const hide = () => {
      knownRef.current = false;
      schedulePaint();
    };

    const handleMouseMove = (e: MouseEvent) => moveTo(e.clientX, e.clientY);

    // Leaving the viewport entirely — the cursor is somewhere we can't draw.
    const handleMouseLeave = () => hide();

    // Entering an iframe: the parent stops seeing the cursor from here on, so
    // either the frame forwards it (clearing this timer) or we stop drawing.
    const handleMouseOver = (e: MouseEvent) => {
      if (!(e.target instanceof HTMLIFrameElement)) return;
      clearSilenceTimer();
      silenceRef.current = setTimeout(hide, FRAME_SILENCE_MS);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseover', handleMouseOver);
    document.addEventListener('mouseleave', handleMouseLeave);
    const offCursorMove = iframeMessages.on('yaar:cursor-move', (ctx) => {
      if (!ctx.source) return;
      const { x, y } = ctx.source.toViewport(ctx.data.clientX ?? 0, ctx.data.clientY ?? 0);
      moveTo(x, y);
    });

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseover', handleMouseOver);
      document.removeEventListener('mouseleave', handleMouseLeave);
      offCursorMove();
      clearSilenceTimer();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [schedulePaint]);

  // The element only exists while an agent runs, so place it on the frame it
  // mounts rather than waiting for the next pointer event to move it there.
  useLayoutEffect(() => {
    if (hasActiveAgents) paint();
  }, [hasActiveAgents, paint]);

  if (!hasActiveAgents) {
    return null;
  }

  return <div ref={elRef} className={styles.spinner} style={{ opacity: 0 }} aria-hidden="true" />;
}
