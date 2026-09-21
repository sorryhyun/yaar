/**
 * Modal - the backdrop every blocking dialog renders inside.
 *
 * What it owns so the dialogs don't each half-do it: `role="dialog"` + `aria-modal`,
 * Escape (through `useDismissable`, so a modal stacked over another surface takes the
 * first Escape and only that one), an optional backdrop press, keeping Tab inside, and
 * giving focus back to whatever had it when the modal goes.
 *
 * On open it focuses the **backdrop itself** when nothing inside has claimed focus (a
 * field with `autoFocus` has, and is left alone). Not the first button: these dialogs are
 * raised by an agent, often mid-sentence in the command palette, and the next Enter the
 * user was already going to press would land on whichever button came first.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { useDismissable } from '@/hooks/useDismissable';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  /** The backdrop's class — each dialog keeps its own look. */
  className: string;
  children: ReactNode;
  /** Accessible name when the dialog has no single heading to point at. */
  label?: string;
  /** Escape (and, with `dismissOnBackdrop`, a backdrop press). Omit for a modal that must be answered. */
  onDismiss?: () => void;
  dismissOnBackdrop?: boolean;
}

export function Modal({ className, children, label, onDismiss, dismissOnBackdrop }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);

  useDismissable({ onDismiss: () => onDismiss?.(), enabled: !!onDismiss });

  useEffect(() => {
    const node = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    if (!node?.contains(document.activeElement)) node?.focus();
    return () => {
      // Only hand focus back if it is still ours to give: a modal that closed because the
      // user clicked somewhere else should leave the focus where they put it.
      const active = document.activeElement;
      const ours = !active || active === document.body || node?.contains(active);
      if (ours && previous?.isConnected) previous.focus();
    };
  }, []);

  const trapTab = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !ref.current) return;
    const focusables = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={ref}
      className={className}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      style={{ outline: 'none' }}
      onKeyDown={trapTab}
      onClick={
        dismissOnBackdrop && onDismiss
          ? (e) => {
              if (e.target === e.currentTarget) onDismiss();
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}
