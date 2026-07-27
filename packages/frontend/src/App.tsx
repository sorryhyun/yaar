import { useState, useEffect } from 'react';
import { DesktopSurface } from './components/desktop';
import { ConnectionDialog } from './components/overlays/ConnectionDialog';
import { LoadingScreen } from './components/overlays';
import {
  apiFetch,
  parseHashConnection,
  getRemoteConnection,
  setRemoteConnection,
  clearRemoteConnection,
} from './lib/api';

type AppState = 'checking' | 'local' | 'remote' | 'dialog';

export default function App() {
  const [state, setState] = useState<AppState>('checking');

  useEffect(() => {
    // 1. Check hash fragment (e.g., #remote=<token>)
    const hashConn = parseHashConnection();
    if (hashConn) {
      setRemoteConnection(hashConn);
      history.replaceState(null, '', window.location.pathname);
      setState('remote');
      return;
    }

    // 2. Check saved remote connection
    const saved = getRemoteConnection();
    if (saved) {
      // Validate the *token*, not just reachability: the server mints a fresh remote
      // token on every start, so a saved connection outlives the token it holds. /health
      // is auth-exempt and would answer 200 for a dead token, landing us in 'remote' with
      // credentials the server rejects.
      apiFetch('/api/apps')
        .then((r) => {
          if (r.ok) {
            setState('remote');
          } else {
            clearRemoteConnection();
            checkLocal();
          }
        })
        .catch(() => {
          clearRemoteConnection();
          checkLocal();
        });
      return;
    }

    // 3. Check for local server
    checkLocal();
  }, []);

  function checkLocal() {
    fetch('/health')
      .then(async (r) => {
        if (!r.ok) return setState('dialog');
        // Reachable — but a remote-mode server needs a token we don't have (no hash
        // fragment, nothing saved). Ask for it instead of connecting unauthenticated.
        const info = (await r.json().catch(() => null)) as { remote?: boolean } | null;
        setState(info?.remote ? 'dialog' : 'local');
      })
      .catch(() => setState('dialog'));
  }

  if (state === 'checking') return null;
  if (state === 'dialog') {
    return <ConnectionDialog onConnected={() => setState('remote')} />;
  }
  return (
    <>
      <LoadingScreen />
      <DesktopSurface />
    </>
  );
}
