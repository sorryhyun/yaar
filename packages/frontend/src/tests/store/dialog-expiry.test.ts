/**
 * An expired dialog leaves the screen (Slice 4 — F-17).
 *
 * A confirm dialog has a deadline the user cannot see. When it passes, the server stops
 * listening and tells the tool that asked "denied" — but the dialog itself used to stay
 * up, still offering buttons wired to a request that no longer existed. The user's click
 * went nowhere, including the "remember my choice" ticked alongside it.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import type { OSAction } from '@yaar/shared';
import { useDesktopStore } from '../../store/desktop';

const show: OSAction = {
  type: 'dialog.confirm',
  id: 'dlg-1',
  title: 'Allow?',
  message: 'Something wants in',
} as OSAction;

describe('dialog expiry', () => {
  beforeEach(() => {
    useDesktopStore.setState({ dialogs: {} });
  });

  it('takes the dialog off the screen when the server stops waiting', () => {
    const { handleDialogAction } = useDesktopStore.getState();

    handleDialogAction(show);
    expect(useDesktopStore.getState().dialogs['dlg-1']).toBeDefined();

    handleDialogAction({ type: 'dialog.close', id: 'dlg-1', reason: 'timeout' } as OSAction);

    expect(useDesktopStore.getState().dialogs['dlg-1']).toBeUndefined();
  });

  it('leaves other dialogs alone', () => {
    const { handleDialogAction } = useDesktopStore.getState();

    handleDialogAction(show);
    handleDialogAction({ ...show, id: 'dlg-2' } as OSAction);
    handleDialogAction({ type: 'dialog.close', id: 'dlg-1' } as OSAction);

    expect(useDesktopStore.getState().dialogs['dlg-1']).toBeUndefined();
    expect(useDesktopStore.getState().dialogs['dlg-2']).toBeDefined();
  });
});
