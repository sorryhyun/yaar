/**
 * A restored window's iframe token must name the *live* session, not the transcript.
 *
 * There are two session id namespaces and they meet in `POST /api/sessions/:id/restore`:
 * the path names a `session_logs/` directory (`2026-08-03_12-37-06`, what `/api/sessions`
 * is keyed by), while the hub is keyed by `ses-…`. The route minted every restored
 * window's iframe token against the *path* id, so each app the Restore banner brought back
 * held a token for a session the hub had never held. `POST /api/verb` then parked the full
 * `SessionHub.waitFor()` on each of its session-scoped calls (`yaar://session/agents`,
 * `yaar://windows`, …) and answered a retryable 503 — for the life of the window, until a
 * reconnect happened to re-mint the token. Process Explorer, whose every panel is
 * session-scoped, simply never loaded; apps that mostly read storage looked fine.
 *
 * Same collision 3f978c48 untangled on the CONNECTION_STATUS path, a different door.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { handleSessionRoutes } from '../http/routes/sessions.js';
import { SESSIONS_DIR } from '../logging/index.js';
import { validateIframeToken } from '../http/iframe-tokens.js';
import { getSessionHub } from '../session/session-hub.js';
import type { SessionId } from '../session/types.js';

const LOG_ID = '2026-08-03_12-37-06';
const LIVE_ID = 'ses-restore1' as SessionId;

async function seedTranscript(): Promise<void> {
  const dir = join(SESSIONS_DIR, LOG_ID);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'metadata.json'),
    JSON.stringify({
      createdAt: '2026-08-03T03:37:06.000Z',
      provider: 'claude',
      lastActivity: '2026-08-03T03:37:06.000Z',
      agents: {},
    }),
  );
  const create = {
    type: 'action',
    timestamp: '2026-08-03T03:38:00.000Z',
    agentId: 'monitor-0',
    parentAgentId: null,
    action: {
      type: 'window.create',
      windowId: '0/process-explorer',
      title: 'Process Explorer',
      content: { renderer: 'iframe', data: '/api/apps/process-explorer/dist/index.html' },
      appId: 'process-explorer',
    },
  };
  await writeFile(join(dir, 'messages.jsonl'), JSON.stringify(create) + '\n');
}

async function restore(body: object): Promise<{ actions: Array<Record<string, unknown>> }> {
  const url = new URL(`http://localhost:8000/api/sessions/${LOG_ID}/restore`);
  const req = new Request(url.href, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await handleSessionRoutes(req, url);
  expect(res?.status).toBe(200);
  return (await res!.json()) as { actions: Array<Record<string, unknown>> };
}

/** The one restored iframe window, and the token it was handed. */
function tokenOf(actions: Array<Record<string, unknown>>): string {
  const win = actions.find((a) => a.type === 'window.create' && a.appId === 'process-explorer');
  expect(win).toBeDefined();
  expect(typeof win!.iframeToken).toBe('string');
  return win!.iframeToken as string;
}

beforeEach(async () => {
  await seedTranscript();
});

afterEach(async () => {
  await rm(join(SESSIONS_DIR, LOG_ID), { recursive: true, force: true });
  await getSessionHub().remove(LIVE_ID);
});

describe('POST /api/sessions/:id/restore — iframe tokens', () => {
  it('mints against the live session the desktop names, not the transcript id', async () => {
    getSessionHub().attach(LIVE_ID, {});

    const { actions } = await restore({ sessionId: LIVE_ID });

    const entry = validateIframeToken(tokenOf(actions));
    expect(entry?.sessionId).toBe(LIVE_ID);
    expect(entry?.sessionId).not.toBe(LOG_ID);
  });

  it('falls back to the hub default rather than the transcript id', async () => {
    getSessionHub().attach(LIVE_ID, {});

    // A desktop that names nothing (or names a session the hub does not hold) must still
    // not be handed the log directory as its session.
    const { actions } = await restore({ sessionId: 'ses-gone42' });

    const entry = validateIframeToken(tokenOf(actions));
    expect(entry?.sessionId).not.toBe(LOG_ID);
    expect(entry?.sessionId).not.toBe('ses-gone42');
  });

  it('never names the transcript, even with no live session at all', async () => {
    const { actions } = await restore({});

    const entry = validateIframeToken(tokenOf(actions));
    // Empty, not the log id: `POST /api/verb` resolves the default session at call time
    // for a token that names none, and 503s outright for one that names a stranger.
    expect(entry?.sessionId).toBe('');
  });
});
