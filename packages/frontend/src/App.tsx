import { useState, useEffect } from 'react';
import { DesktopSurface } from './components/desktop';
import { ConnectionDialog } from './components/ui/ConnectionDialog';
import { LoadingScreen } from './components/ui/LoadingScreen';
import {
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
      // Validate saved connection is still alive
      fetch(`${saved.serverUrl}/health`)
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
      .then((r) => {
        if (r.ok) setState('local');
        else setState('dialog');
      })
      .catch(() => setState('dialog'));
  }

  if (state === 'checking') return <LoadingScreen />;
  if (state === 'dialog') {
    return <ConnectionDialog onConnected={() => setState('remote')} />;
  }
  return (
    <>
      <DesktopSurface />
      <LoadingScreen />
    </>
  );
}
