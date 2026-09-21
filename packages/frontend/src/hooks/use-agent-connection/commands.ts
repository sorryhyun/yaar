/**
 * Everything the client says to the server.
 *
 * Plain functions, deliberately not React. Each one reads the store through
 * `getState()` and the socket through `wsManager`, so none of them closes over props,
 * state or context — they were thirteen `useCallback(..., [])`s wearing a hook for no
 * reason, and being a hook is what made five components mount the whole connection
 * layer just to reach one of them. The socket lifecycle lives next door in
 * `connection.ts`; this module never opens or closes one.
 */
import { useDesktopStore, resendAppProtocolReady } from '@/store';
import type { ClientEvent } from '@/types';
import { ClientEventType } from '@/types';
import { wsManager, sendEvent } from './transport-manager';
import { generateActionId, generateMessageId } from './outbound-command-helpers';
import { drainPendingQueues } from './usePendingEventDrainer';
import { captureMonitorScreenshot } from '@/lib/captureMonitorScreenshot';

/**
 * Put an event on the wire, and say whether it got there.
 *
 * The return value is the whole point. This used to return nothing and swallow a closed
 * socket with a `console.warn`, so every caller was structurally incapable of noticing
 * that the thing it had just "sent" was never sent — including the one that had already
 * consumed the user's drawing to build it.
 */
export function send(event: ClientEvent): boolean {
  return sendEvent(wsManager, event);
}

/**
 * Resend everything the server has not acknowledged.
 *
 * Safe to call repeatedly: the server dedups by message id, so a message that did land
 * before the socket died is acked a second time rather than run a second time.
 */
export function flushOutbox(): void {
  const store = useDesktopStore.getState();
  for (const entry of store.pendingOutbox()) {
    if (send(entry.event)) store.trackMessage(entry.messageId, 'sent');
  }
}

/**
 * Say everything the server may have missed while we were apart.
 *
 * That includes what our iframes already told us but only ever told the server once: App
 * Protocol readiness lives in the server's memory, and a restarted server has a session,
 * a monitor and a window but no idea the app inside it ever registered — so it refuses
 * every app_query/app_command against that window, permanently, until the tab is
 * reloaded. We witnessed the registration and the iframe is still mounted; re-announcing
 * is cheap and idempotent server-side.
 */
export function flushPending(): void {
  drainPendingQueues({ send, addCliEntry: useDesktopStore.getState().addCliEntry });
  resendAppProtocolReady();
  flushOutbox();
}

export function resync(): void {
  send({ type: ClientEventType.RESYNC });
}

export async function sendMessage(content: string): Promise<void> {
  // Capture full monitor screenshot (with drawing strokes composited)
  // before consuming the drawing, so the sent image includes the desktop.
  const hasDrawingNow = useDesktopStore.getState().hasDrawing;
  let screenshotDataUrl: string | null = null;
  if (hasDrawingNow) {
    screenshotDataUrl = await captureMonitorScreenshot();
  }

  const store = useDesktopStore.getState();
  const drawing = store.consumeDrawing();
  const images = store.consumeAttachedImages();
  const messageId = generateMessageId();
  const monitorId = store.activeMonitorId;
  // CLI-panel "act as me" toggle — route to the session agent (the user's
  // deputy) only while the CLI panel is open; the main palette stays on the
  // monitor agent.
  const { cliMode, cliTarget } = store;
  const target = cliMode && cliTarget === 'session' ? 'session' : undefined;
  store.addCliEntry({ type: 'user', content, monitorId });

  const interactions: Array<{ type: 'draw'; timestamp: number; imageData: string }> = [];
  // Prefer the composite screenshot; fall back to raw strokes
  const drawingImage = screenshotDataUrl ?? drawing;
  if (drawingImage) {
    interactions.push({ type: 'draw', timestamp: Date.now(), imageData: drawingImage });
  }
  for (const img of images) {
    interactions.push({ type: 'draw', timestamp: Date.now(), imageData: img });
  }

  const event: ClientEvent = {
    type: ClientEventType.USER_MESSAGE,
    messageId,
    content,
    monitorId,
    interactions: interactions.length > 0 ? interactions : undefined,
    target,
  };

  // Into the outbox *before* the wire. The drawing and the images have already been
  // consumed out of the store to build this event — if the send fails and nothing is
  // holding the event, they are gone for good, and the CLI panel is left claiming the
  // user asked for something that was never asked. The outbox is what holds them: the
  // message stays there, attachments and all, until the server acks it, and is resent
  // on reconnect.
  store.enqueueOutbox(messageId, event);
  store.trackMessage(messageId, send(event) ? 'sent' : 'unsent');
}

export function sendWindowMessage(windowId: string, content: string): void {
  const messageId = generateMessageId();
  useDesktopStore.getState().trackMessage(messageId);
  send({
    type: ClientEventType.WINDOW_MESSAGE,
    messageId,
    windowId,
    content,
  });
}

export function sendDialogFeedback(
  dialogId: string,
  confirmed: boolean,
  rememberChoice?: 'once' | 'always' | 'deny_always',
): void {
  send({ type: ClientEventType.DIALOG_FEEDBACK, dialogId, confirmed, rememberChoice });
}

export function sendToastAction(toastId: string, eventId: string): void {
  send({ type: ClientEventType.TOAST_ACTION, toastId, eventId });
}

/**
 * Answer a prompt an agent is parked on.
 *
 * Returns whether the answer reached the wire, because the caller has to know: the box
 * is the only copy of an answer that never got sent, and taking it down anyway left the
 * user certain they had replied while the agent waited out its full deadline.
 *
 * Deliberately *not* held in the outbox, unlike a user message. The outbox settles on a
 * `MESSAGE_ACCEPTED`/`MESSAGE_QUEUED`/`ERROR` naming a message id, and a prompt answer
 * has neither an id nor an ack — it would sit there and be resent on every reconnect
 * forever. Recovery is the snapshot instead: the server still holds the prompt as a live
 * surface until it is answered, so reconnecting re-shows it.
 *
 * The answer is also echoed into the asking monitor's CLI history. Without it the tmux
 * view showed the agent acting on something the transcript never recorded.
 */
export function sendUserPromptResponse(
  prompt: { id: string; title: string; monitorId?: string },
  answer: { selectedValues?: string[]; text?: string; dismissed?: boolean },
): boolean {
  const delivered = send({
    type: ClientEventType.USER_PROMPT_RESPONSE,
    promptId: prompt.id,
    selectedValues: answer.selectedValues,
    text: answer.text,
    dismissed: answer.dismissed,
  });
  if (!delivered) return false;

  const parts = [
    answer.selectedValues?.length ? answer.selectedValues.join(', ') : '',
    answer.text ?? '',
  ].filter(Boolean);
  const store = useDesktopStore.getState();
  store.addCliEntry({
    type: 'user',
    content: `[${prompt.title}] ${answer.dismissed ? '(skipped)' : parts.join(' — ')}`,
    // A prompt from before this field existed, or from an agent with no monitor at
    // all, is echoed where the user is looking rather than into pane 0 by default.
    monitorId: prompt.monitorId ?? store.activeMonitorId,
  });
  return true;
}

export function sendComponentAction(
  windowId: string,
  windowTitle: string,
  action: string,
  parallel?: boolean,
  formData?: Record<string, string | number | boolean>,
  formId?: string,
  componentPath?: string[],
): void {
  const actionId = generateActionId(parallel);
  send({
    type: ClientEventType.COMPONENT_ACTION,
    windowId,
    windowTitle,
    action,
    actionId,
    formData,
    formId,
    componentPath,
  });
}

export function interrupt(): void {
  send({ type: ClientEventType.INTERRUPT });
}

export function interruptAgent(agentId: string): void {
  send({ type: ClientEventType.INTERRUPT_AGENT, agentId });
}

/**
 * Clear the context of one monitor — the one the caller is looking at.
 *
 * Both halves have to be scoped together or they disagree about what was reset: the
 * event tells the server which agent tree to forget, `resetDesktop` clears the matching
 * client state. Omitting `monitorId` keeps the session-wide behavior for callers that
 * have no monitor in hand.
 *
 * Into the outbox first, for the same reason a user message goes there: `send` returning
 * true means the frame reached *our* end of the socket, and a phone coming back from
 * another app routinely holds one whose peer is long gone (see `recoverAfterResume`).
 * The local clear below then ran against a server that had never heard of the reset —
 * the transcript emptied, the toast appeared, and the next message was answered by the
 * conversation the button exists to end. The outbox holds it until the server acks it and
 * resends it on the next attach; the server dedups, so a reset that did land is not run
 * twice.
 *
 * The desktop is still cleared straight away rather than on the ack. The ack is
 * ordinarily immediate, but `resetSession` is not, and a reset button that leaves the old
 * transcript on screen while an agent is rebuilt reads as a button that did nothing.
 */
export function reset(monitorId?: string): void {
  const messageId = generateMessageId();
  const store = useDesktopStore.getState();
  const event: ClientEvent = { type: ClientEventType.RESET, monitorId, messageId };
  store.enqueueOutbox(messageId, event);
  send(event);
  store.resetDesktop(monitorId);
}
