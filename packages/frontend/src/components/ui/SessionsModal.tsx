/**
 * SessionsModal - Modal for viewing and recovering previous sessions.
 */
import { useState, useEffect, useCallback } from 'react'
import { useDesktopStore } from '@/store'
import styles from '@/styles/SessionsModal.module.css'

interface SessionInfo {
  sessionId: string
  metadata: {
    createdAt: string
    provider: string
    lastActivity: string
  }
}

export function SessionsModal() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<string | null>(null)
  const [loadingTranscript, setLoadingTranscript] = useState(false)
  const toggleSessionsModal = useDesktopStore((state) => state.toggleSessionsModal)

  useEffect(() => {
    fetchSessions()
  }, [])

  const fetchSessions = async () => {
    try {
      setLoading(true)
      setError(null)
      const response = await fetch('/api/sessions')
      if (!response.ok) {
        throw new Error('Failed to fetch sessions')
      }
      const data = await response.json()
      setSessions(data.sessions)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions')
    } finally {
      setLoading(false)
    }
  }

  const handleViewSession = useCallback(async (sessionId: string) => {
    if (selectedSession === sessionId) {
      setSelectedSession(null)
      setTranscript(null)
      return
    }

    try {
      setLoadingTranscript(true)
      setSelectedSession(sessionId)
      const response = await fetch(`/api/sessions/${sessionId}/transcript`)
      if (!response.ok) {
        throw new Error('Failed to fetch transcript')
      }
      const data = await response.json()
      setTranscript(data.transcript)
    } catch (err) {
      setTranscript('Failed to load transcript')
    } finally {
      setLoadingTranscript(false)
    }
  }, [selectedSession])

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleString()
  }

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      toggleSessionsModal()
    }
  }

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2 className={styles.title}>Sessions</h2>
          <button className={styles.closeButton} onClick={toggleSessionsModal}>
            &times;
          </button>
        </div>
        <div className={styles.content}>
          {loading ? (
            <div className={styles.loading}>Loading sessions...</div>
          ) : error ? (
            <div className={styles.error}>{error}</div>
          ) : sessions.length === 0 ? (
            <div className={styles.empty}>No sessions found</div>
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
                      <span className={styles.date}>
                        {formatDate(session.metadata.createdAt)}
                      </span>
                    </div>
                  </div>
                  {selectedSession === session.sessionId && (
                    <div className={styles.transcriptContainer}>
                      {loadingTranscript ? (
                        <div className={styles.loading}>Loading transcript...</div>
                      ) : transcript ? (
                        <pre className={styles.transcript}>{transcript}</pre>
                      ) : (
                        <div className={styles.empty}>No transcript available</div>
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
  )
}
