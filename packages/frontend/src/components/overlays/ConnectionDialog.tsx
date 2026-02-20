/**
 * ConnectionDialog - Shown when no local server is detected.
 * Allows connecting to a remote YAAR server with URL + token.
 */
import { useState, useCallback, useEffect } from 'react';
import {
  parseHashConnection,
  getRemoteConnection,
  setRemoteConnection,
  type RemoteConnection,
} from '@/lib/api';
import styles from '@/styles/overlays/ConnectionDialog.module.css';

interface ConnectionDialogProps {
  onConnected: () => void;
}

export function ConnectionDialog({ onConnected }: ConnectionDialogProps) {
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  // Auto-connect from hash fragment on mount
  useEffect(() => {
    const hashConn = parseHashConnection();
    if (hashConn) {
      // Clear hash from URL
      history.replaceState(null, '', window.location.pathname);
      testAndConnect(hashConn);
      return;
    }
    // Pre-fill from saved connection
    const saved = getRemoteConnection();
    if (saved) {
      setServerUrl(saved.serverUrl);
      setToken(saved.token);
    }
  }, []);

  const testAndConnect = useCallback(
    async (conn: RemoteConnection) => {
      setTesting(true);
      setError(null);
      try {
        // Test health endpoint (no auth needed)
        const healthRes = await fetch(`${conn.serverUrl}/health`);
        if (!healthRes.ok) throw new Error('Server not reachable');

        // Test auth with providers endpoint
        const provRes = await fetch(`${conn.serverUrl}/api/providers`, {
          headers: { Authorization: `Bearer ${conn.token}` },
        });
        if (provRes.status === 401) throw new Error('Invalid token');
        if (!provRes.ok) throw new Error('Connection test failed');

        setRemoteConnection(conn);
        onConnected();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Connection failed');
      } finally {
        setTesting(false);
      }
    },
    [onConnected],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmedUrl = serverUrl.replace(/\/+$/, '');
      if (!trimmedUrl || !token) {
        setError('Server URL and token are required');
        return;
      }
      testAndConnect({ serverUrl: trimmedUrl, token });
    },
    [serverUrl, token, testAndConnect],
  );

  return (
    <div className={styles.backdrop}>
      <div className={styles.card}>
        <h2 className={styles.title}>Connect to YAAR</h2>
        <p className={styles.subtitle}>
          No local server detected. Enter your remote server details.
        </p>
        <form className={styles.form} onSubmit={handleSubmit}>
          <label className={styles.label}>
            Server URL
            <input
              className={styles.input}
              type="url"
              placeholder="http://192.168.1.100:8000"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              disabled={testing}
            />
          </label>
          <label className={styles.label}>
            Token
            <input
              className={styles.input}
              type="text"
              placeholder="Paste token from server terminal"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={testing}
            />
          </label>
          {error && <div className={styles.error}>{error}</div>}
          <button className={styles.button} type="submit" disabled={testing}>
            {testing ? 'Connecting...' : 'Connect'}
          </button>
        </form>
      </div>
    </div>
  );
}
