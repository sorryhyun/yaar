import { list, read, errMsg, withLoading } from '@bundled/yaar';
import { state, setState } from './store';
import type { SessionSummary, SessionDetail } from './types';

export async function loadSessions(): Promise<void> {
  setState('loadError', null);
  await withLoading((v: boolean) => setState('loading', v), async () => {
    const result = await list<{ currentSessionId?: string; sessions: SessionSummary[] }>(
      'yaar://sessions/'
    );
    const arr = Array.isArray(result?.sessions) ? result.sessions : [];
    if (result?.currentSessionId) setState('currentSessionId', result.currentSessionId);
    // Sort newest first
    arr.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    setState('sessions', arr);
    setState('totalCount', arr.length);
  }, (msg) => {
    console.error('Failed to load sessions', msg);
    setState('loadError', msg);
  });
}

export async function loadDetail(sessionId: string): Promise<void> {
  setState('selectedId', sessionId);
  setState('detail', null);
  setState('detailLoading', true);
  try {
    const d = await read<SessionDetail>(`yaar://sessions/${sessionId}`);
    if (!d.sessionId) (d as Record<string, unknown>).sessionId = sessionId;
    setState('detail', d);
  } catch (e) {
    console.error('Failed to load detail', e);
    // Fallback: use summary data from the list
    const s = state.sessions.find(s => s.sessionId === sessionId);
    if (s) setState('detail', s as unknown as SessionDetail);
  } finally {
    setState('detailLoading', false);
  }
}
