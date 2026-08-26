/**
 * Decisions behind the shell's reserved keyboard shortcuts, kept out of the
 * component so they can be unit-tested against a plain store snapshot.
 */
import { DEFAULT_MONITOR_ID, keybindingsClaimKey } from '@yaar/shared';
import type { DesktopStore } from '@/store/types';

type ShortcutState = Pick<
  DesktopStore,
  'windows' | 'zOrder' | 'activeMonitorId' | 'appKeybindings'
>;

/**
 * The window Ctrl+W should close, or null when it should close nothing.
 *
 * Topmost on the active monitor, not the focused one: clicking the desktop
 * background clears `focusedWindowId`, and the old handler then declined to act
 * — which let the keystroke through to Chrome, closing the whole YAAR window.
 * The shell claims Ctrl+W unconditionally now; this only answers what happens
 * next. `zOrder` already encodes the layering the user sees (panels are not in
 * it at all, widgets sit under standard windows), so its last visible entry is
 * literally the window on top.
 *
 * Returns null when the topmost window's app binds the `w` key. That app owns
 * the key, and a window closing under a shortcut its own author redefined is
 * the surprise worth avoiding — see `keybindingsClaimKey`.
 */
export function resolveCloseTopWindow(state: ShortcutState): string | null {
  for (let i = state.zOrder.length - 1; i >= 0; i--) {
    const id = state.zOrder[i];
    const win = state.windows[id];
    if (!win || win.minimized) continue;
    if ((win.monitorId ?? DEFAULT_MONITOR_ID) !== state.activeMonitorId) continue;
    const combos = win.appId ? state.appKeybindings[win.appId] : undefined;
    if (combos && keybindingsClaimKey(combos, 'w')) return null;
    return id;
  }
  return null;
}

/**
 * Whether an event is the shell's Ctrl+W — plain, no other modifier.
 *
 * The old test was `ctrlKey && key === 'w'`, which also swallowed Ctrl+Shift+W
 * and Ctrl+Alt+W. Those are combos an app is allowed to bind (only `ctrl+w`
 * itself is reserved), so claiming them closed the window *and* ate the
 * shortcut.
 */
export function isCloseWindowShortcut(e: {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w';
}

/**
 * Whether closing the tab right now should cost the user a confirmation dialog.
 *
 * This is the only lever we have against ⌘W on macOS. `isCloseWindowShortcut` is
 * Ctrl-only on purpose: the Mac close key is ⌘W, and that one is a Chrome *menu*
 * key equivalent, dispatched from the browser's pre-renderer shortcut table — the
 * page never gets the chance to cancel it, so widening the predicate to `metaKey`
 * would close the top YAAR window *and* lose the browser window with it. What a
 * page is still allowed to do is ask `beforeunload` for a "Leave site?" prompt,
 * which is what this gates.
 *
 * `zOrder` rather than `windows`: panels aren't in it at all, so the dock — which
 * is always present — doesn't make a bare desktop look occupied. On a desktop with
 * nothing open there is nothing to lose (the session itself survives on the server
 * and reconnects), and prompting there would be friction for no gain.
 */
export function shouldConfirmUnload(state: Pick<DesktopStore, 'zOrder'>): boolean {
  return state.zOrder.length > 0;
}
