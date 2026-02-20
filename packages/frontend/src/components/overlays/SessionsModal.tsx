/**
 * SessionsModal - Modal for viewing and recovering previous sessions.
 */
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useDesktopStore } from '@/store';
import type { OSAction } from '@yaar/shared';
import { apiFetch } from '@/lib/api';
import styles from '@/styles/overlays/SessionsModal.module.css';

interface SessionInfo {
  sessionId: string;
  metadata: {
    createdAt: string;
    provider: string;
    lastActivity: string;
  };
}

export function SessionsModal() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const toggleSessionsModal = useDesktopStore((state) => state.toggleSessionsModal);
  const applyActions = useDesktopStore((state) => state.applyActions);
  const clearDesktop = useDesktopStore((state) => state.clearDesktop);

  useEffect(() => {
    fetchSessions();
  }, []);

  const fetchSessions = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await apiFetch('/api/sessions');
      if (!response.ok) {
        throw new Error(t('sessions.error.fetchSessions'));
      }
      const data = await response.json();
      setSessions(data.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('sessions.error.loadSessions'));
    } finally {
      setLoading(false);
    }
  };

  const handleViewSession = useCallback(
    async (sessionId: string) => {
      if (selectedSession === sessionId) {
        setSelectedSession(null);
        setTranscript(null);
        return;
      }

      try {
        setLoadingTranscript(true);
        setSelectedSession(sessionId);
        const response = await apiFetch(`/api/sessions/${sessionId}/transcript`);
        if (!response.ok) {
          throw new Error(t('sessions.error.fetchTranscript'));
        }
        const data = await response.json();
        setTranscript(data.transcript);
      } catch {
        setTranscript(t('sessions.error.loadTranscript'));
      } finally {
        setLoadingTranscript(false);
      }
    },
    [selectedSession],
  );

  const handleRestoreSession = useCallback(
    async (sessionId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        setRestoring(sessionId);
        const response = await apiFetch(`/api/sessions/${sessionId}/restore`, { method: 'POST' });
        if (!response.ok) {
          throw new Error(t('sessions.error.restore'));
        }
        const data = await response.json();
        clearDesktop();
        if (data.actions && Array.isArray(data.actions)) {
          applyActions(data.actions as OSAction[]);
        }
        toggleSessionsModal();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to restore session');
      } finally {
        setRestoring(null);
      }
    },
    [applyActions, clearDesktop, toggleSessionsModal],
  );

  const handleExportSession = useCallback(async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      setExporting(sessionId);
      // Fetch both transcript and messages
      const [transcriptRes, messagesRes] = await Promise.all([
        apiFetch(`/api/sessions/${sessionId}/transcript`),
        apiFetch(`/api/sessions/${sessionId}/messages`),
      ]);

      const transcriptData = transcriptRes.ok ? await transcriptRes.json() : null;
      const messagesData = messagesRes.ok ? await messagesRes.json() : null;

      const exportData = {
        sessionId,
        exportedAt: new Date().toISOString(),
        transcript: transcriptData?.transcript || null,
        messages: messagesData?.messages || null,
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-${sessionId}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('sessions.error.export'));
    } finally {
      setExporting(null);
    }
  }, []);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      toggleSessionsModal();
    }
  };

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2 className={styles.title}>{t('sessions.title')}</h2>
          <button className={styles.closeButton} onClick={toggleSessionsModal}>
            &times;
          </button>
        </div>
        <div className={styles.content}>
          {loading ? (
            <div className={styles.loading}>{t('sessions.loading')}</div>
          ) : error ? (
            <div className={styles.error}>{error}</div>
          ) : sessions.length === 0 ? (
            <div className={styles.empty}>{t('sessions.empty')}</div>
          ) : (
            <div className={styles.sessionList}>
              {sessions.map((session) => (
                <div key={session.sessionId} className={styles.sessionItem}>
                  <div
                    className={styles.sessionHeader}
                    onClick={() => handleViewSession(session.sessionId)}
                    data-selected={selectedSession === session.sessionId}
                  >
                    <div className={styles.sessionInfo}>
                      <span className={styles.sessionId}>{session.sessionId}</span>
                      <span className={styles.provider}>{session.metadata.provider}</span>
                    </div>
                    <div className={styles.sessionMeta}>
                      <span className={styles.date}>{formatDate(session.metadata.createdAt)}</span>
                      <button
                        className={styles.actionButton}
                        onClick={(e) => handleRestoreSession(session.sessionId, e)}
                        disabled={restoring === session.sessionId}
                        title={t('sessions.restoreTitle')}
                      >
                        {restoring === session.sessionId ? '...' : t('sessions.restore')}
                      </button>
                      <button
                        className={styles.actionButton}
                        onClick={(e) => handleExportSession(session.sessionId, e)}
                        disabled={exporting === session.sessionId}
                        title={t('sessions.exportTitle')}
                      >
                        {exporting === session.sessionId ? '...' : t('sessions.export')}
                      </button>
                    </div>
                  </div>
                  {selectedSession === session.sessionId && (
                    <div className={styles.transcriptContainer}>
                      {loadingTranscript ? (
                        <div className={styles.loading}>{t('sessions.transcript.loading')}</div>
                      ) : transcript ? (
                        <pre className={styles.transcript}>{transcript}</pre>
                      ) : (
                        <div className={styles.empty}>{t('sessions.transcript.empty')}</div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
