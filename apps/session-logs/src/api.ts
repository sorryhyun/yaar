import { list, read, errMsg } from '@bundled/yaar';
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
  setLoading(true);
  setLoadError(null);
  try {
    const result = await list<{ currentSessionId?: string; sessions: SessionSummary[] }>(
      'yaar://sessions/'
    );
    const arr = Array.isArray(result?.sessions) ? result.sessions : [];
    if (result?.currentSessionId) setCurrentSessionId(result.currentSessionId);
    // Sort newest first
    arr.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    setSessions(arr);
    setTotalCount(arr.length);
  } catch (e) {
    console.error('Failed to load sessions', e);
    setLoadError(errMsg(e));
  } finally {
    setLoading(false);
  }
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
