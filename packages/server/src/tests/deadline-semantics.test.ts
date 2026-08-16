/**
 * Deadlines fail loudly (Slice 4 — F-15, F-16, F-17).
 *
 * One rule, three findings: **a deadline that passes is not an answer.** Every pending
 * request in the server used to resolve, on expiry, with a value its caller had supplied
 * in advance as "what to say if nothing comes back" — and none of those callers could
 * then tell that nothing had come back. A window whose iframe never reported was
 * announced to the agent as rendered; a prompt the user never saw was reported as one
 * they declined; a dialog whose deadline passed was denied on the server while its
 * buttons stayed live on the user's screen.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ServerEventType, type OSAction, type ServerEvent } from '@yaar/shared';
import { checkPermission, clearPermission } from '../storage/permissions.js';
import { getConfigDir } from '../storage/storage-manager.js';
import { PendingStore } from '../session/pending-store.js';
import { actionEmitter, type UserPromptResult } from '../session/action-emitter.js';
import type { SessionScopedEvent } from '../session/emitter-channels.js';
import { LiveSession } from '../session/live-session.js';
import { getBroadcastCenter } from '../session/broadcast-center.js';
import { runWithAgentContext } from '../agents/agent-context.js';
import type { SessionId, YaarWebSocket } from '../session/types.js';
import { emitActionChecked } from '../features/window/helpers.js';
import { askUser } from '../features/user/prompts.js';
import { MAX_COMMAND_TIMEOUT_MS } from '../features/window/app-protocol.js';
import {
  MAX_REQUEST_DEADLINE_MS,
  MCP_TOOL_CALL_TIMEOUT_MS,
  TRANSPORT_IDLE_TIMEOUT_S,
  buildClaudeEnv,
  clampDeadline,
} from '../config.js';

/** Collect the actions the emitter sends to a whole session (dialog closes, prompt dismissals). */
function collectSessionActions(sink: OSAction[]): () => void {
  const handler = (data: SessionScopedEvent) => {
    if (data.event.type !== ServerEventType.ACTIONS) return;
    sink.push(...data.event.actions);
  };
  actionEmitter.on('session-action', handler);
  return () => actionEmitter.off('session-action', handler);
}

/** Wait for a pending expiry to fire and its listeners to run. */
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A socket that records what the session broadcast to it. */
function fakeSocket(sink: ServerEvent[]): YaarWebSocket {
  return {
    readyState: 1, // WS_OPEN
    send: (data: string) => sink.push(JSON.parse(data) as ServerEvent),
  } as unknown as YaarWebSocket;
}

describe('F-15 — a timeout is never observable as a success', () => {
  it('reports an expired entry as a timeout, not as a value', async () => {
    const store = new PendingStore<{ success: boolean }>();
    const outcome = await store.create('req-1', { timeoutMs: 5 });

    expect(outcome).toEqual({ ok: false, reason: 'timeout' });
  });

  it('reports an answered entry as an answer', async () => {
    const store = new PendingStore<{ success: boolean }>();
    const pending = store.create('req-1', { timeoutMs: 1000 });

    expect(store.resolve('req-1', { success: true })).toMatchObject({ resolved: true });
    expect(await pending).toEqual({ ok: true, value: { success: true } });
  });

  it('distinguishes a session that went away from a deadline that passed', async () => {
    const store = new PendingStore<string>();
    const pending = store.create('req-1', { timeoutMs: 1000, sessionId: 'sess-a' });

    store.clearForSession('sess-a');

    expect(await pending).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('resolving an id it no longer holds is reported, not swallowed', () => {
    const store = new PendingStore<string>();
    expect(store.resolve('never-existed', 'late')).toEqual({ resolved: false });
  });

  it('an unanswered rendering request does not come back looking like a rendered window', async () => {
    // No frontend is listening, so no feedback ever arrives. This is exactly the
    // window.create path: it used to receive `null` and read it as "no failure reported".
    const outcome = await actionEmitter.emitActionWithFeedback(
      { type: 'window.capture', windowId: '0/nobody-home' } as OSAction,
      10,
      'sess-render',
      '0',
    );

    expect(outcome).toEqual({ ok: false, reason: 'timeout' });
  });

  it('still lets a veto-only action through when nobody vetoes it', async () => {
    // The one place silence legitimately means success: the frontend answers window.close
    // and window.updateContent *only* to refuse them (the window is locked by another
    // agent). No answer means no objection — and that has to keep working, or every close
    // and every update starts failing.
    const result = await runWithAgentContext(
      { agentId: 'monitor:0', sessionId: 'sess-veto' as SessionId, monitorId: '0' },
      () =>
        emitActionChecked(
          { type: 'window.close', windowId: '0/some-window' } as OSAction,
          10,
          'should not be reported',
        ),
    );

    expect(result).toBeNull();
  });

  it('an expired prompt is not reported to the agent as the user declining', async () => {
    const timedOut: UserPromptResult = { dismissed: true, timedOut: true };
    const original = actionEmitter.showUserPrompt;
    actionEmitter.showUserPrompt = (async () => timedOut) as typeof actionEmitter.showUserPrompt;

    try {
      const result = await askUser({
        title: 'Pick one',
        message: 'Which?',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      });

      expect(result.success).toBe(false);
      // "User dismissed the prompt" is a statement about the user. Nobody was there.
      expect(result.error).not.toContain('dismissed');
      expect(result.error).toContain('expired');
    } finally {
      actionEmitter.showUserPrompt = original;
    }
  });

  it('a prompt whose deadline passes says so', async () => {
    // Inside a session, because a prompt with nowhere to go is a different outcome —
    // `dismissed` with no `timedOut`, since no deadline was ever started. That is the
    // distinction this test exists to protect, from the other side.
    const result = await runWithAgentContext(
      { agentId: 'agent-prompt', sessionId: 'sess-prompt' as SessionId },
      () =>
        actionEmitter.showUserPrompt({
          title: 'Still there?',
          message: 'Answer within 10ms',
          inputField: { placeholder: '...' },
          timeoutMs: 10,
        }),
    );

    expect(result).toEqual({ dismissed: true, timedOut: true });
  });
});

describe('a deadline nobody can answer is not a deadline', () => {
  /**
   * The other half of F-15's rule. There, a deadline that passed was reported as an
   * answer; here, a deadline is *waited out* for an answer that provably cannot arrive —
   * the window holding the responder closed while the request was in flight.
   *
   * The two are indistinguishable to the caller, and that is what makes it a defect
   * rather than a slow path: a relayed command whose job is to destroy its own responder
   * (`closeWindow`) burns its full budget and then reports a timeout, whose standing
   * advice is "retry with a larger timeoutMs". The operation had already succeeded.
   */
  it('settles an in-flight app request as `closed` the moment its window goes', async () => {
    const sessionId = 'sess-window-death' as SessionId;
    const session = new LiveSession(sessionId);

    try {
      session.windowState.handleAction(
        {
          type: 'window.create',
          windowId: 'probe',
          title: 'probe',
          bounds: { x: 0, y: 0, w: 100, h: 100 },
          content: { renderer: 'iframe', data: 'yaar://apps/probe' },
          appId: 'probe',
        } as OSAction,
        '0',
      );

      // A budget far longer than the test could tolerate waiting out: if the cancellation
      // does not happen, this assertion does not fail, it hangs — which is exactly the
      // symptom being fixed.
      const pending = actionEmitter.emitAppProtocolRequest(
        '0/probe',
        { kind: 'command', command: 'closeWindow' },
        MAX_COMMAND_TIMEOUT_MS,
        sessionId,
      );
      await settle(5);

      const startedAt = Date.now();
      session.windowState.handleAction({ type: 'window.close', windowId: 'probe' }, '0');
      const outcome = await pending;

      expect(outcome.ok).toBe(false);
      // Not `timeout` — the distinction is the whole point, because it is what tells the
      // caller that retrying is pointless and the command may well have succeeded.
      expect((outcome as { reason: string }).reason).toBe('closed');
      expect(Date.now() - startedAt).toBeLessThan(1000);
    } finally {
      await session.cleanup();
    }
  });

  it('leaves requests to other windows alone', async () => {
    const sessionId = 'sess-window-death-scope' as SessionId;
    const session = new LiveSession(sessionId);

    try {
      for (const windowId of ['doomed', 'bystander']) {
        session.windowState.handleAction(
          {
            type: 'window.create',
            windowId,
            title: windowId,
            bounds: { x: 0, y: 0, w: 100, h: 100 },
            content: { renderer: 'iframe', data: `yaar://apps/${windowId}` },
            appId: windowId,
          } as OSAction,
          '0',
        );
      }

      const bystander = actionEmitter.emitAppProtocolRequest(
        '0/bystander',
        { kind: 'query', stateKey: 'anything' },
        60,
        sessionId,
      );
      const doomed = actionEmitter.emitAppProtocolRequest(
        '0/doomed',
        { kind: 'command', command: 'closeWindow' },
        MAX_COMMAND_TIMEOUT_MS,
        sessionId,
      );
      await settle(5);

      session.windowState.handleAction({ type: 'window.close', windowId: 'doomed' }, '0');

      expect((await doomed) as { reason?: string }).toMatchObject({ reason: 'closed' });
      // The survivor keeps its own deadline and reaches it on its own terms — one
      // window's death must not cancel another's conversation.
      expect((await bystander) as { reason?: string }).toMatchObject({ reason: 'timeout' });
    } finally {
      await session.cleanup();
    }
  });
});

describe('F-16 — no inner deadline outlives the transport carrying it', () => {
  it('keeps the request budget strictly inside the transport idle timeout', () => {
    // A tool call waiting on the user holds an HTTP request open. If the inner deadline
    // is the larger one, the connection is closed before it fires: the answer is written
    // to a socket nobody is reading, and the timer goes on ticking against a request that
    // no longer exists. The prompt deadline (300s) and the external-MCP call ceiling
    // (300s) both used to sit past the 255s transport bound.
    expect(MAX_REQUEST_DEADLINE_MS).toBeLessThan(TRANSPORT_IDLE_TIMEOUT_S * 1000);
  });

  it('caps a caller-supplied deadline at the budget', () => {
    expect(clampDeadline(300_000)).toBe(MAX_REQUEST_DEADLINE_MS);
    expect(clampDeadline(5_000)).toBe(5_000);
  });

  it('keeps the app-command ceiling inside the budget', () => {
    expect(MAX_COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(MAX_REQUEST_DEADLINE_MS);
  });

  it("keeps the budget inside the caller's tool-call ceiling too", () => {
    // YAAR's transport is not the outermost bound — the MCP client waiting on the tool
    // call has one too, and aborts the POST at 60s unless told otherwise. Above that
    // clock, YAAR's expiry is unreportable for the same reason a past-the-transport one
    // is: measured, a 240s prompt was abandoned by the agent at 60,019ms and the dialog
    // it had raised stayed answerable for three more minutes.
    expect(MAX_REQUEST_DEADLINE_MS).toBeLessThan(MCP_TOOL_CALL_TIMEOUT_MS);
    expect(MCP_TOOL_CALL_TIMEOUT_MS).toBeLessThan(TRANSPORT_IDLE_TIMEOUT_S * 1000);
  });

  it('tells the spawned CLI that ceiling, rather than leaving it at 60s', () => {
    // An invariant asserted only between constants would hold while the caller went on
    // using its default, which is exactly the state this fixes.
    expect(buildClaudeEnv().MCP_TOOL_TIMEOUT).toBe(String(MCP_TOOL_CALL_TIMEOUT_MS));
  });
});

describe('F-17 — an expired dialog leaves the screen', () => {
  let configDir: string;
  let previousConfig: string | undefined;

  beforeAll(async () => {
    // savePermission writes config/permissions.json. Point it somewhere disposable — though
    // when the whole suite runs, hooks.test.ts has already mocked storage-manager
    // process-wide (Bun never restores those), so the write lands in its __test-config__
    // instead. Either way the decision must not outlive this file: left behind, it would
    // pre-deny `late_tool` on the next run and the assertion below would pass without the
    // code under test doing anything.
    previousConfig = process.env.YAAR_CONFIG;
    configDir = await mkdtemp(join(tmpdir(), 'yaar-deadline-'));
    process.env.YAAR_CONFIG = configDir;
  });

  afterAll(async () => {
    await clearPermission('late_tool');
    // ...and take the file itself with us, wherever the (possibly mocked) config dir put it.
    await rm(join(getConfigDir(), 'permissions.json'), { force: true });
    if (previousConfig === undefined) delete process.env.YAAR_CONFIG;
    else process.env.YAAR_CONFIG = previousConfig;
    await rm(configDir, { recursive: true, force: true });
  });

  let actions: OSAction[];
  let stop: () => void;

  beforeEach(() => {
    actions = [];
    stop?.();
    stop = collectSessionActions(actions);
  });

  it('takes the dialog off the screen when the server stops waiting for it', async () => {
    const answered = actionEmitter.showPermissionDialogToSession('sess-dialog' as string, {
      title: 'Allow?',
      message: 'Something wants in',
      toolName: 'some_tool',
      timeoutMs: 10,
    });

    // Unanswered means denied, and the user is not left looking at a live dialog for a
    // request that has already been refused.
    expect(await answered).toBe(false);
    await settle(5);

    const close = actions.find((a) => a.type === 'dialog.close');
    expect(close).toBeDefined();
    expect((close as { reason?: string }).reason).toBe('timeout');

    stop();
  });

  it('delivers the close to a connected tab, not just to the emitter', async () => {
    // The close is emitted from a timer callback, where there is no agent turn and so no
    // monitor to stamp. It therefore rides the session-scoped channel and must reach every
    // connection through LiveSession.broadcast() — emitting it on the 'action' channel
    // instead would have reached only a session with a live ToolActionBridge subscription,
    // which by expiry time is exactly what a session may no longer have.
    const sessionId = 'sess-wire' as SessionId;
    const received: ServerEvent[] = [];
    const session = new LiveSession(sessionId);
    const bc = getBroadcastCenter();
    bc.subscribe('conn-wire', fakeSocket(received), sessionId);

    try {
      await actionEmitter.showPermissionDialogToSession(sessionId, {
        title: 'Allow?',
        message: 'Something wants in',
        toolName: 'wire_tool',
        timeoutMs: 10,
      });
      await settle(5);

      const delivered = received
        .filter((e) => e.type === ServerEventType.ACTIONS)
        .flatMap((e) => (e as unknown as { actions: OSAction[] }).actions);

      // The tab was asked (as an APPROVAL_REQUEST, which it turns into a dialog)...
      expect(received.some((e) => e.type === ServerEventType.APPROVAL_REQUEST)).toBe(true);
      // ...and then told to take that dialog back down.
      const close = delivered.find((a) => a.type === 'dialog.close');
      expect(close).toBeDefined();
      expect((close as { reason?: string }).reason).toBe('timeout');
    } finally {
      bc.unsubscribe('conn-wire');
      await session.cleanup();
      stop();
    }
  });

  it('withdraws an expired prompt from the screen too', async () => {
    const result = await runWithAgentContext(
      { agentId: 'agent-fishing', sessionId: 'sess-fishing' as SessionId },
      () =>
        actionEmitter.showUserPrompt({
          title: 'Gone fishing',
          message: 'No one is here',
          inputField: {},
          timeoutMs: 10,
        }),
    );
    await settle(5);

    expect(result.timedOut).toBe(true);
    // The dismissal goes out on the session channel, which is why the prompt has to be
    // bound to a session for there to be anything to withdraw.
    expect(actions.some((a) => a.type === 'user.prompt.dismiss')).toBe(true);
    stop();
  });

  it('still honours "remember my choice" from a click that lands after expiry', async () => {
    const dialogId = await expiredPermissionDialog('sess-late', 'late_tool');

    // The user clicked Deny-always just as the dialog vanished. The request it answered is
    // gone and cannot be un-denied — resolveDialogFeedback says so — but the standing
    // instruction is not about that request, and used to be dropped along with it: the
    // whole late click was discarded, so a user who ticked "don't ask again" a moment too
    // late kept being asked, forever, with no sign their choice had gone anywhere.
    const resolved = await actionEmitter.resolveDialogFeedback({
      dialogId,
      confirmed: false,
      rememberChoice: 'deny_always',
    });

    expect(resolved).toBe(false);
    expect(await checkPermission('late_tool')).toBe('deny');

    // And the standing decision is what the next request actually meets: it is refused
    // outright, without putting a second dialog in front of the user.
    const askedAgain: OSAction[] = [];
    let dialogShown = false;
    const onApproval = () => {
      dialogShown = true;
    };
    actionEmitter.on('approval-request', onApproval);
    const stopClose = collectSessionActions(askedAgain);
    try {
      const allowed = await actionEmitter.showPermissionDialogToSession('sess-late', {
        title: 'Allow?',
        message: 'Something wants in again',
        toolName: 'late_tool',
        timeoutMs: 10,
      });
      expect(allowed).toBe(false);
      expect(dialogShown).toBe(false);
    } finally {
      actionEmitter.off('approval-request', onApproval);
      stopClose();
    }

    stop();
  });

  /** Show a permission dialog to nobody and let it expire; returns its dialog id. */
  async function expiredPermissionDialog(sessionId: string, toolName: string): Promise<string> {
    const shown: OSAction[] = [];
    const seen: string[] = [];
    const onApproval = (data: SessionScopedEvent) => {
      if (data.event.type === ServerEventType.APPROVAL_REQUEST) seen.push(data.event.dialogId);
    };
    actionEmitter.on('approval-request', onApproval);
    const stopClose = collectSessionActions(shown);

    try {
      await actionEmitter.showPermissionDialogToSession(sessionId, {
        title: 'Allow?',
        message: 'Something wants in',
        toolName,
        timeoutMs: 10,
      });
      await settle(5);
      expect(shown.some((a) => a.type === 'dialog.close')).toBe(true);
      return seen[0]!;
    } finally {
      actionEmitter.off('approval-request', onApproval);
      stopClose();
    }
  }
});
