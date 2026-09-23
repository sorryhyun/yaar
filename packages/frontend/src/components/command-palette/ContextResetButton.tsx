/**
 * ContextResetButton - resets the active monitor's windows and agent context.
 *
 * The desktop keeps it in the command palette's icon cluster. A phone has no button for
 * it at all: the palette row is under the thumb all session, the wrong place for a
 * destructive control, so the pen took that slot — and pulling the open shade down a
 * second time runs the same reset (`resetActiveMonitorContext`), a drag long enough that
 * it has to be meant.
 */
import i18next from 'i18next';
import { useTranslation } from 'react-i18next';
import { reset } from '@/hooks/useAgentConnection';
import { useDesktopStore } from '@/store';

/**
 * Reset the monitor this tab is looking at, and say so. A plain function rather than the
 * button's handler because the phone's way in is not a button but pulling the already-open
 * shade down again (`PhoneGestures`) — and the two must toast the same thing.
 */
export function resetActiveMonitorContext(): void {
  const { activeMonitorId, monitors, applyAction } = useDesktopStore.getState();
  // The palette belongs to the desktop it sits on, so the reset does too — the other
  // monitors' agents, transcripts and queues keep running.
  reset(activeMonitorId);
  // With one monitor there is nothing to disambiguate. With several, an unqualified
  // "Context reset" reads as "all of it was reset", which is the opposite of the truth.
  const label = monitors.find((m) => m.id === activeMonitorId)?.label;
  applyAction({
    type: 'toast.show',
    id: `reset-${Date.now()}`,
    message:
      monitors.length > 1 && label
        ? i18next.t('commandPalette.toast.contextResetMonitor', { monitor: label })
        : i18next.t('commandPalette.toast.contextReset'),
    variant: 'info',
  });
}

export function ContextResetButton({ className }: { className?: string }) {
  const { t } = useTranslation();

  return (
    <button
      className={className}
      onClick={resetActiveMonitorContext}
      title={t('commandPalette.tooltip.reset')}
    >
      <ResetIcon />
    </button>
  );
}

/** The reset glyph, shared with the shade's pull-to-clear hint. */
export function ResetIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M1.66669 3.33334V8.33334H6.66669"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.51669 12.5C4.09225 14.1245 5.19153 15.5077 6.64804 16.4297C8.10455 17.3517 9.8327 17.7602 11.5504 17.5894C13.2682 17.4186 14.8764 16.6787 16.1113 15.4888C17.3463 14.2989 18.1348 12.7265 18.3593 11.0178C18.5838 9.30909 18.231 7.57261 17.357 6.09244C16.4831 4.61227 15.1384 3.47475 13.5359 2.85192C11.9335 2.22909 10.1668 2.15772 8.51986 2.64888C6.87291 3.14005 5.44223 4.16467 4.45003 5.56668L1.66669 8.33334"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
