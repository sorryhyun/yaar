/**
 * Catches a phone's Back button, so it puts away what is on top instead of leaving YAAR.
 *
 * The page has no Back of its own to hear, only window.history. So the shell keeps one extra entry
 * of its own — the *guard* — on top of wherever the desktop was loaded: Back pops the guard,
 * `popstate` fires, `stepBack` puts one layer away, and the guard goes back on for the next
 * press. With nothing left to put away, the guard stays off and a toast says so; the next
 * Back is then a real one and leaves, the way a phone app's does.
 *
 * Chrome skips, on Back, a history entry the page added without the user having touched it
 * since. The guard is pushed at mount and after each Back, so it is honoured from the user's
 * first tap onwards — before that, Back leaves, which is also what it did before there was a
 * desktop to go back through.
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { stepBack } from '@/lib/phoneBack';
import { useDesktopStore } from '@/store';

/** How long "press Back again to leave" waits for the second press. */
export const EXIT_HINT_MS = 2000;

const GUARD_KEY = 'yaarBackGuard';

function onGuard(): boolean {
  const s = window.history.state as Record<string, unknown> | null;
  return !!s && s[GUARD_KEY] === true;
}

function pushGuard() {
  window.history.pushState({ [GUARD_KEY]: true }, '');
}

export function usePhoneBack() {
  const isMobile = useDesktopStore((s) => s.formFactor === 'mobile');
  const { t } = useTranslation();

  useEffect(() => {
    if (!isMobile) return;
    // A reload keeps the history entry it was on; a guard already there is ours.
    if (!onGuard()) pushGuard();

    let hintTimer: ReturnType<typeof setTimeout> | null = null;

    const onPopState = () => {
      // Back has taken the guard off. A Forward (or an in-page hash jump) that lands back
      // on a guard is not a Back at all.
      if (onGuard()) return;
      if (stepBack()) {
        if (hintTimer) clearTimeout(hintTimer);
        hintTimer = null;
        pushGuard();
        return;
      }
      // Bare desktop: leave the guard off, so the next Back leaves. If it does not come
      // soon, put the guard back — a Back minutes later is not the second of a pair.
      useDesktopStore.getState().applyAction({
        type: 'toast.show',
        id: 'phone-back-exit',
        message: t('desktop.backAgainToExit'),
        variant: 'info',
        duration: EXIT_HINT_MS,
      });
      if (hintTimer) clearTimeout(hintTimer);
      hintTimer = setTimeout(() => {
        hintTimer = null;
        if (!onGuard()) pushGuard();
      }, EXIT_HINT_MS);
    };

    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      if (hintTimer) clearTimeout(hintTimer);
      // The guard is left in place: popping it here would land as a `popstate` on the next
      // mount (StrictMode mounts twice), and read as a Back nobody pressed.
    };
  }, [isMobile, t]);
}
