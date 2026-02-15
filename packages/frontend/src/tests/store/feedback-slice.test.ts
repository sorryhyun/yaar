/**
 * Tests for the feedback slice of the Zustand store.
 * Covers App Protocol responses, App Protocol ready, and App Interactions queues.
 */
import { useDesktopStore } from '../../store/desktop';

describe('Feedback Slice', () => {
  beforeEach(() => {
    useDesktopStore.setState({
      pendingFeedback: [],
      pendingAppProtocolResponses: [],
      pendingAppProtocolReady: [],
      pendingAppInteractions: [],
    });
  });

  describe('App Protocol Responses', () => {
    it('addPendingAppProtocolResponse adds an item to the array', () => {
      const { addPendingAppProtocolResponse } = useDesktopStore.getState();

      addPendingAppProtocolResponse({
        requestId: 'req-1',
        windowId: 'win-1',
        response: { kind: 'query', data: 'hello' },
      });

      const state = useDesktopStore.getState();
      expect(state.pendingAppProtocolResponses).toHaveLength(1);
      expect(state.pendingAppProtocolResponses[0]).toMatchObject({
        requestId: 'req-1',
        windowId: 'win-1',
      });
    });

    it('addPendingAppProtocolResponse accumulates multiple items', () => {
      const { addPendingAppProtocolResponse } = useDesktopStore.getState();

      addPendingAppProtocolResponse({
        requestId: 'req-1',
        windowId: 'win-1',
        response: { kind: 'query', data: 'first' },
      });
      addPendingAppProtocolResponse({
        requestId: 'req-2',
        windowId: 'win-2',
        response: { kind: 'query', data: 'second' },
      });

      const state = useDesktopStore.getState();
      expect(state.pendingAppProtocolResponses).toHaveLength(2);
      expect(state.pendingAppProtocolResponses[0].requestId).toBe('req-1');
      expect(state.pendingAppProtocolResponses[1].requestId).toBe('req-2');
    });

    it('consumePendingAppProtocolResponses returns all items and clears the array', () => {
      const { addPendingAppProtocolResponse } = useDesktopStore.getState();

      addPendingAppProtocolResponse({
        requestId: 'req-1',
        windowId: 'win-1',
        response: { kind: 'query', data: 'a' },
      });
      addPendingAppProtocolResponse({
        requestId: 'req-2',
        windowId: 'win-2',
        response: { kind: 'query', data: 'b' },
      });

      const { consumePendingAppProtocolResponses } = useDesktopStore.getState();
      const consumed = consumePendingAppProtocolResponses();

      expect(consumed).toHaveLength(2);
      expect(consumed[0].requestId).toBe('req-1');
      expect(consumed[1].requestId).toBe('req-2');
      expect(useDesktopStore.getState().pendingAppProtocolResponses).toHaveLength(0);
    });

    it('consumePendingAppProtocolResponses returns empty array when no items pending', () => {
      const { consumePendingAppProtocolResponses } = useDesktopStore.getState();
      const consumed = consumePendingAppProtocolResponses();

      expect(consumed).toEqual([]);
      expect(useDesktopStore.getState().pendingAppProtocolResponses).toHaveLength(0);
    });
  });

  describe('App Protocol Ready', () => {
    it('addAppProtocolReady adds a windowId', () => {
      const { addAppProtocolReady } = useDesktopStore.getState();

      addAppProtocolReady('win-1');

      const state = useDesktopStore.getState();
      expect(state.pendingAppProtocolReady).toHaveLength(1);
      expect(state.pendingAppProtocolReady[0]).toBe('win-1');
    });

    it('addAppProtocolReady accumulates multiple windowIds', () => {
      const { addAppProtocolReady } = useDesktopStore.getState();

      addAppProtocolReady('win-1');
      addAppProtocolReady('win-2');
      addAppProtocolReady('win-3');

      const state = useDesktopStore.getState();
      expect(state.pendingAppProtocolReady).toHaveLength(3);
      expect(state.pendingAppProtocolReady).toEqual(['win-1', 'win-2', 'win-3']);
    });

    it('consumeAppProtocolReady returns all and clears, returns [] when empty', () => {
      const { addAppProtocolReady } = useDesktopStore.getState();

      addAppProtocolReady('win-1');
      addAppProtocolReady('win-2');

      const { consumeAppProtocolReady } = useDesktopStore.getState();
      const consumed = consumeAppProtocolReady();

      expect(consumed).toEqual(['win-1', 'win-2']);
      expect(useDesktopStore.getState().pendingAppProtocolReady).toHaveLength(0);

      // Second consume should return empty
      const { consumeAppProtocolReady: consumeAgain } = useDesktopStore.getState();
      expect(consumeAgain()).toEqual([]);
    });
  });

  describe('App Interactions', () => {
    it('addPendingAppInteraction adds an interaction item', () => {
      const { addPendingAppInteraction } = useDesktopStore.getState();

      addPendingAppInteraction({ windowId: 'win-1', content: 'clicked button' });

      const state = useDesktopStore.getState();
      expect(state.pendingAppInteractions).toHaveLength(1);
      expect(state.pendingAppInteractions[0]).toEqual({
        windowId: 'win-1',
        content: 'clicked button',
      });
    });

    it('addPendingAppInteraction accumulates multiple items', () => {
      const { addPendingAppInteraction } = useDesktopStore.getState();

      addPendingAppInteraction({ windowId: 'win-1', content: 'first action' });
      addPendingAppInteraction({ windowId: 'win-2', content: 'second action' });
      addPendingAppInteraction({ windowId: 'win-1', content: 'third action' });

      const state = useDesktopStore.getState();
      expect(state.pendingAppInteractions).toHaveLength(3);
      expect(state.pendingAppInteractions[0].content).toBe('first action');
      expect(state.pendingAppInteractions[2].windowId).toBe('win-1');
    });

    it('consumePendingAppInteractions returns all and clears, returns [] when empty', () => {
      const { addPendingAppInteraction } = useDesktopStore.getState();

      addPendingAppInteraction({ windowId: 'win-1', content: 'interaction A' });
      addPendingAppInteraction({ windowId: 'win-2', content: 'interaction B' });

      const { consumePendingAppInteractions } = useDesktopStore.getState();
      const consumed = consumePendingAppInteractions();

      expect(consumed).toHaveLength(2);
      expect(consumed[0]).toEqual({ windowId: 'win-1', content: 'interaction A' });
      expect(consumed[1]).toEqual({ windowId: 'win-2', content: 'interaction B' });
      expect(useDesktopStore.getState().pendingAppInteractions).toHaveLength(0);

      // Second consume should return empty
      const { consumePendingAppInteractions: consumeAgain } = useDesktopStore.getState();
      expect(consumeAgain()).toEqual([]);
    });
  });
});
