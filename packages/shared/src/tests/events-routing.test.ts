/**
 * The two queue-bypass tables are why a client frame may overtake the connection queue.
 * Only the server's loopback tests exercised them, and those go through a whole session;
 * these pin the tables themselves. A frame in both lists would be classified by whichever
 * predicate the socket asks first, and the two lists overtake for different reasons —
 * `routing.ts` argues each entry on its own terms — so they must stay disjoint. `RESYNC`
 * is the one frame whose meaning is its queue position, so it must be in neither.
 */
import { describe, it, expect } from 'bun:test';
import {
  ANSWER_EVENT_TYPES,
  CONTROL_EVENT_TYPES,
  ClientEventType,
  ServerEventType,
  isAnswerEvent,
  isControlEvent,
} from '../events/routing.js';

describe('queue-bypass tables', () => {
  it('keeps answer and control frames disjoint', () => {
    const answers = new Set<string>(ANSWER_EVENT_TYPES);
    const overlap = CONTROL_EVENT_TYPES.filter((type) => answers.has(type));
    expect(overlap).toEqual([]);
  });

  it('lists each frame once', () => {
    expect(new Set(ANSWER_EVENT_TYPES).size).toBe(ANSWER_EVENT_TYPES.length);
    expect(new Set(CONTROL_EVENT_TYPES).size).toBe(CONTROL_EVENT_TYPES.length);
  });

  it('names only client frame types', () => {
    const clientTypes = new Set<string>(Object.values(ClientEventType));
    for (const type of [...ANSWER_EVENT_TYPES, ...CONTROL_EVENT_TYPES]) {
      expect(clientTypes.has(type)).toBe(true);
    }
  });

  it('leaves RESYNC queued', () => {
    expect(isAnswerEvent(ClientEventType.RESYNC)).toBe(false);
    expect(isControlEvent(ClientEventType.RESYNC)).toBe(false);
  });
});

describe('isAnswerEvent / isControlEvent', () => {
  it('agree with their tables for every client frame type', () => {
    for (const type of Object.values(ClientEventType)) {
      expect(isAnswerEvent(type)).toBe((ANSWER_EVENT_TYPES as readonly string[]).includes(type));
      expect(isControlEvent(type)).toBe((CONTROL_EVENT_TYPES as readonly string[]).includes(type));
    }
  });

  it('reject server frame types and unknown strings', () => {
    for (const type of [...Object.values(ServerEventType), '', 'app_protocol_response']) {
      expect(isAnswerEvent(type)).toBe(false);
      expect(isControlEvent(type)).toBe(false);
    }
  });
});
