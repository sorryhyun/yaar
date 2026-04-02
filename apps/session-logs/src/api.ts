import { read, withLoading } from '@bundled/yaar';
import { state, setState } from './store';
import type { SessionSummary, SessionDetail, ParsedMessage } from './types';

export async function loadSessions(): Promise<void> {
  setState('loadError', null);
  await withLoading((v: boolean) => setState('loading', v), async () => {
    const result = await read<{ currentSessionId?: string; sessions: SessionSummary[] }>(
      'yaar://history/'
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
  setState('transcript', null);
  setState('messages', null);
  setState('detailLoading', true);
  try {
    const d = await read<SessionDetail>(`yaar://history/${sessionId}`);
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
  // Load transcript and messages in background for agent access
  loadTranscript(sessionId);
  loadMessages(sessionId);
}

export async function loadTranscript(sessionId: string): Promise<void> {
  try {
    const data = await read<string>(`yaar://history/${sessionId}/transcript`);
    if (state.selectedId === sessionId) {
      setState('transcript', typeof data === 'string' ? data : String(data));
    }
  } catch (e) {
    console.error('Failed to load transcript', e);
  }
}

export async function loadMessages(sessionId: string): Promise<void> {
  try {
    const data = await read<{ messages: ParsedMessage[] }>(
      `yaar://history/${sessionId}/messages`
    );
    if (state.selectedId === sessionId) {
      setState('messages', data.messages);
    }
  } catch (e) {
    console.error('Failed to load messages', e);
  }
}
