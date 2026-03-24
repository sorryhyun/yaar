import { list, read, errMsg, withLoading } from '@bundled/yaar';
import {
  sessions,
  setSessions,
  setCurrentSessionId,
  setLoading,
  setLoadError,
  setTotalCount,
  setDetail,
  setDetailLoading,
  setSelectedId,
} from './store';
import type { SessionSummary, SessionDetail } from './types';

export async function loadSessions(): Promise<void> {
  setLoadError(null);
  await withLoading(setLoading, async () => {
    const result = await list<{ currentSessionId?: string; sessions: SessionSummary[] }>(
      'yaar://sessions/'
    );
    const arr = Array.isArray(result?.sessions) ? result.sessions : [];
    if (result?.currentSessionId) setCurrentSessionId(result.currentSessionId);
    // Sort newest first
    arr.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    setSessions(arr);
    setTotalCount(arr.length);
  }, (msg) => {
    console.error('Failed to load sessions', msg);
    setLoadError(msg);
  });
}

export async function loadDetail(sessionId: string): Promise<void> {
  setSelectedId(sessionId);
  setDetail(null);
  setDetailLoading(true);
  try {
    const d = await read<SessionDetail>(`yaar://sessions/${sessionId}`);
    if (!d.sessionId) (d as Record<string, unknown>).sessionId = sessionId;
    setDetail(d);
  } catch (e) {
    console.error('Failed to load detail', e);
    // Fallback: use summary data from the list
    const s = sessions().find(s => s.sessionId === sessionId);
    if (s) setDetail(s as unknown as SessionDetail);
  } finally {
    setDetailLoading(false);
  }
}
