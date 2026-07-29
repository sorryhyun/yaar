/**
 * What the app-install dialog puts on screen.
 *
 * The dialog used to render one pre-formatted string, so a permission request reached the
 * user as `yaar://storage/` and nothing else — the grant without the meaning. The server
 * now sends structured rows; these assert the two things that makes possible and one
 * thing it must not cost: the plain-language line leads, the literal grant survives
 * alongside it, and a dialog that sends no rows still renders its message as before.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { useDesktopStore } from '@/store';
import type { CapabilityLine } from '@yaar/shared';

const sendDialogFeedback = mock(
  (_id: string, _confirmed: boolean, _remember?: 'once' | 'always' | 'deny_always') => {},
);

mock.module('@/hooks/useAgentConnection', () => ({
  useAgentConnection: () => ({ sendDialogFeedback }),
}));

const { ConfirmDialog } = await import('@/components/overlays/ConfirmDialog');

function seedDialog(capabilities?: CapabilityLine[]) {
  useDesktopStore.setState({
    dialogs: {
      d1: {
        id: 'd1',
        title: 'App Permissions',
        message: '"notes" requests the following:',
        confirmText: 'Install',
        cancelText: 'Cancel',
        timestamp: Date.now(),
        ...(capabilities ? { capabilities } : {}),
      },
    },
  } as never);
}

describe('the app-install permission dialog', () => {
  beforeEach(() => {
    sendDialogFeedback.mockClear();
    useDesktopStore.setState({ dialogs: {} } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it('leads with what the app can do and keeps the raw grant beside it', () => {
    seedDialog([
      { icon: '📁', title: 'Read and write your files', raw: 'yaar://storage/', warn: true },
    ]);
    render(<ConfirmDialog />);

    expect(screen.getByText('Read and write your files')).toBeTruthy();
    expect(screen.getByText('yaar://storage/')).toBeTruthy();
    // The lead sentence names the app; it is not replaced by the rows.
    expect(screen.getByText('"notes" requests the following:')).toBeTruthy();
  });

  it('still renders a dialog that sends no rows', () => {
    seedDialog();
    render(<ConfirmDialog />);

    expect(screen.getByText('"notes" requests the following:')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('renders one row per grant, so nothing asked for goes unshown', () => {
    seedDialog([
      { icon: '📁', title: 'Store its own data', detail: 'Private to this app', raw: 'a' },
      { icon: '🌐', title: 'Access the internet', raw: 'b' },
      { icon: '🤖', title: 'Run up to 2 AI personas of its own' },
    ]);
    render(<ConfirmDialog />);

    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('Private to this app')).toBeTruthy();
  });
});
