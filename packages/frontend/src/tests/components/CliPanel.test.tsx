/**
 * The CLI panel's monitor switch, which exists only on a phone.
 *
 * On a desktop the grid *is* the switcher: every monitor has a pane, and clicking one
 * focuses it. A phone shows a single pane — two terminals on a 412px screen are two
 * unreadable columns — and the sideways pan out of the CLI goes back to the desktop
 * rather than along the monitor list, so without these buttons another monitor's
 * terminal could not be read at all from a phone.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useDesktopStore } from '@/store';
import { CliPanel } from '@/components/overlays/CliPanel';

const monitor = (id: string, label: string) => ({ id, label, createdAt: 0 });

describe('CliPanel monitor switch', () => {
  const switchSpy = mock(() => {});

  // Store *actions* are singletons every test file in this process shares, so the real
  // one has to be captured before the spy goes in — restoring `getState().switchMonitor`
  // afterwards would just put the spy back, and the next file's pans would go nowhere.
  const realSwitchMonitor = useDesktopStore.getState().switchMonitor;

  beforeEach(() => {
    switchSpy.mockClear();
    useDesktopStore.setState({
      monitors: [monitor('0', 'Monitor 1'), monitor('m2', 'Monitor 2')],
      activeMonitorId: '0',
      formFactor: 'mobile',
      cliHistory: {},
      cliTarget: 'monitor',
      switchMonitor: switchSpy,
    } as never);
  });

  afterEach(() => {
    cleanup();
    useDesktopStore.setState({ formFactor: 'desktop', switchMonitor: realSwitchMonitor });
  });

  it('offers a button per monitor, numbered like the pane badges', () => {
    render(<CliPanel />);
    const group = screen.getByRole('group', { name: 'Monitor' });
    expect([...group.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['1', '2']);
  });

  it('switches the monitor the single pane is showing', () => {
    render(<CliPanel />);
    fireEvent.click(screen.getByTitle('Monitor 2'));
    expect(switchSpy).toHaveBeenCalledWith('m2');
  });

  it('marks the one being shown', () => {
    render(<CliPanel />);
    expect(screen.getByTitle('Monitor 1')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTitle('Monitor 2')).toHaveAttribute('data-active', 'false');
  });

  // Nothing to switch between, and a row of one button that does nothing is worse than
  // no row: it takes the same space and answers a question nobody asked.
  it('says nothing with a single monitor', () => {
    useDesktopStore.setState({ monitors: [monitor('0', 'Monitor 1')] } as never);
    render(<CliPanel />);
    expect(screen.queryByRole('group', { name: 'Monitor' })).not.toBeInTheDocument();
  });

  // The desktop has the grid, where every monitor is already on screen at once.
  it('is absent on a desktop', () => {
    useDesktopStore.setState({ formFactor: 'desktop' });
    render(<CliPanel />);
    expect(screen.queryByRole('group', { name: 'Monitor' })).not.toBeInTheDocument();
  });
});
