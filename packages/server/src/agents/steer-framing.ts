/**
 * How a message steered into a running turn is presented to the model.
 *
 * A message that *starts* a turn reads as the next thing to answer by its position alone.
 * A steered one lands in the middle of work the model is already doing — between two tool
 * results — and used to arrive bare. In one recorded run an app agent, mid-task, read a role
 * brief its monitor had sent as "a misdirected broadcast… treat as noise" and dropped it,
 * and the monitor waited five minutes for an answer that was never coming (issue #182). So a
 * steered message says what a fresh turn's position says for free: that it is new, where it
 * came from, and that it is this agent's to handle.
 *
 * The body is the task's content unchanged. Its producer already wrapped it the way a fresh
 * turn shows it (`<monitor:…>`, `<from:…>`, `<ui:click>`, `<app:event>`), so the wrapper adds
 * only the mid-turn facts and never re-describes the sender.
 */

import type { TaskKind } from './pool-types.js';

/** The tag a steered message is wrapped in. Exported for tests and log readers. */
export const STEERED_TAG = 'mid_turn_message';

/** `Task.kind` in words the model reads without a glossary. */
const FROM: Record<TaskKind, string> = {
  user: 'user',
  relay: 'agent',
  hook: 'agent-reply',
  notify: 'event',
  remote: 'remote-control',
};

const NOTE =
  'New message, delivered while your turn was running. It is addressed to you — not a ' +
  'broadcast or an echo — so handle it before you end this turn.';

/** Where a steered message came from — the facts the task already carries. */
export interface SteerOrigin {
  kind: TaskKind;
  /** The window it came in through, as the agent names windows (the raw id, not the handle). */
  windowId?: string;
  /** The monitor it came from. For a relay, the sender's. */
  monitorId?: string;
}

export function frameSteeredMessage(content: string, origin: SteerOrigin): string {
  const attrs = [`from="${FROM[origin.kind]}"`];
  if (origin.windowId) attrs.push(`window="${origin.windowId}"`);
  if (origin.monitorId) attrs.push(`monitor="${origin.monitorId}"`);
  return `<${STEERED_TAG} ${attrs.join(' ')}>\n${NOTE}\n\n${content}\n</${STEERED_TAG}>`;
}
