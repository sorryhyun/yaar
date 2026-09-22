/**
 * The one way a shell surface is put away by Escape or by a press outside it.
 *
 * There used to be a hand-rolled listener per surface, and the cost was not the lines but
 * what each one forgot: four dialogs could not be dismissed with Escape at all, and two
 * surfaces open at once each heard the same Escape, so one keypress closed both.
 *
 * Escape goes to the **most recently enabled** surface only. Surfaces register on a stack
 * as they open and leave it as they close, so a dialog raised over the notification shade
 * takes the first Escape and the shade the second — the order the user sees them in.
 */
import { useEffect, useRef, type RefObject } from 'react';

export interface DismissableOptions {
  /** What "put it away" means for this surface. */
  onDismiss: () => void;
  /** Escape dismisses. Default true. */
  escape?: boolean;
  /** A press outside this element dismisses. Omit for surfaces a stray tap must not close. */
  outside?: RefObject<Element | null>;
  /** Off while the surface is closed, so it neither holds a stack slot nor listens. */
  enabled?: boolean;
}

/** Open surfaces that take Escape, oldest first. Each entry is a live ref to its handler. */
const escapeStack: RefObject<() => void>[] = [];

/**
 * Put away the surface on top of the Escape stack, if there is one. Escape is one way in;
 * a phone's Back button is the other — see `usePhoneBack`.
 */
export function dismissTopSurface(): boolean {
  const top = escapeStack[escapeStack.length - 1];
  if (!top) return false;
  top.current?.();
  return true;
}

function onDocumentKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  // The Escape that cancels an IME composition is the IME's — see `lib/ime.ts`.
  if (e.isComposing || e.keyCode === 229) return;
  if (escapeStack.length === 0) return;
  e.preventDefault();
  dismissTopSurface();
}

export function useDismissable({
  onDismiss,
  escape = true,
  outside,
  enabled = true,
}: DismissableOptions): void {
  // Read through a ref so a caller passing an inline closure does not re-register on
  // every render — which would also move it to the top of the Escape stack.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!enabled || !escape) return;
    const entry: RefObject<() => void> = { current: () => dismissRef.current() };
    if (escapeStack.length === 0) document.addEventListener('keydown', onDocumentKeyDown);
    escapeStack.push(entry);
    return () => {
      const i = escapeStack.indexOf(entry);
      if (i !== -1) escapeStack.splice(i, 1);
      if (escapeStack.length === 0) document.removeEventListener('keydown', onDocumentKeyDown);
    };
  }, [enabled, escape]);

  useEffect(() => {
    if (!enabled || !outside) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = outside.current;
      if (el && !el.contains(e.target as Node)) dismissRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [enabled, outside]);
}
