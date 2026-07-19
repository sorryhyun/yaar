/**
 * CLI panel behaviour for the tool `pending` phase.
 *
 * The panel shows a tool call's arguments as raw fragments while the model is
 * still writing them, then replaces that scaffolding with the summarized
 * `[tool] input` entry once they are complete. Two things have to hold for that
 * to be an improvement rather than a mess:
 *
 *   1. the raw fragments never reach `cliHistory` — half-written JSON is not
 *      something anyone should be able to scroll back to, and the summarized
 *      entry always says the same thing better;
 *   2. a fragment never lands on the tail of a *different* feed, which would
 *      splice argument JSON onto the end of the assistant's prose.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { useDesktopStore } from '../../store/desktop';

describe('CLI tool-argument streaming', () => {
  beforeEach(() => {
    useDesktopStore.setState({ cliHistory: {}, cliStreaming: {} });
  });

  it('accumulates argument fragments into one live entry', () => {
    const { updateCliStreaming, appendCliStreaming } = useDesktopStore.getState();

    updateCliStreaming('agent-1', '[Write] ', 'tool', '0');
    appendCliStreaming('agent-1', '{"path":', 'tool', '0');
    appendCliStreaming('agent-1', '"/tmp/a"}', 'tool', '0');

    const live = useDesktopStore.getState().cliStreaming['agent-1'];
    expect(live.type).toBe('tool');
    expect(live.content).toBe('[Write] {"path":"/tmp/a"}');
  });

  it('discards the raw argument entry on finalize instead of committing it', () => {
    const { updateCliStreaming, appendCliStreaming, finalizeCliStreaming, addCliEntry } =
      useDesktopStore.getState();

    updateCliStreaming('agent-1', '[Write] ', 'tool', '0');
    appendCliStreaming('agent-1', '{"path":"/tmp/a"', 'tool', '0');

    // This is what the dispatcher does when the arguments complete: drop the
    // scaffolding, then write the readable form.
    finalizeCliStreaming('agent-1');
    addCliEntry({ type: 'tool', content: '[Write] {"path":"/tmp/a"}', monitorId: '0' });

    const state = useDesktopStore.getState();
    expect(state.cliStreaming['agent-1']).toBeUndefined();
    expect(state.cliHistory['0']).toHaveLength(1);
    expect(state.cliHistory['0'][0].content).toBe('[Write] {"path":"/tmp/a"}');
  });

  it('leaves no partial JSON behind when a turn is interrupted mid-argument', () => {
    const { updateCliStreaming, appendCliStreaming, finalizeCliStreaming } =
      useDesktopStore.getState();

    updateCliStreaming('agent-1', '[Write] ', 'tool', '0');
    appendCliStreaming('agent-1', '{"body":"half-writ', 'tool', '0');
    // Interrupted: no summarized entry will ever arrive.
    finalizeCliStreaming('agent-1');

    const state = useDesktopStore.getState();
    expect(state.cliStreaming['agent-1']).toBeUndefined();
    expect(state.cliHistory['0'] ?? []).toHaveLength(0);
  });

  it('still commits a real assistant text block on finalize', () => {
    const { updateCliStreaming, finalizeCliStreaming } = useDesktopStore.getState();

    // The Codex path has no `pending` phase, so the live entry at tool time may
    // hold genuine assistant text. That must be flushed, not dropped.
    updateCliStreaming('agent-1', 'Let me check that file.', 'response', '0');
    finalizeCliStreaming('agent-1');

    const state = useDesktopStore.getState();
    expect(state.cliHistory['0']).toHaveLength(1);
    expect(state.cliHistory['0'][0]).toMatchObject({
      type: 'response',
      content: 'Let me check that file.',
    });
  });

  it('does not splice a fragment onto a different feed', () => {
    const { updateCliStreaming, appendCliStreaming } = useDesktopStore.getState();

    updateCliStreaming('agent-1', 'Assistant prose.', 'response', '0');
    appendCliStreaming('agent-1', '{"path":', 'tool', '0');

    const live = useDesktopStore.getState().cliStreaming['agent-1'];
    expect(live.type).toBe('tool');
    expect(live.content).toBe('{"path":'); // not glued onto the prose
  });
});
