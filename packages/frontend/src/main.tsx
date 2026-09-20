import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/base/tokens.css';
import './i18n'; // Must be imported before React renders
import App from './App';
import { registerServiceWorker } from './lib/registerServiceWorker';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// After the first render, never before it: the desktop must not wait on the shell cache,
// and on an insecure origin there is no worker to wait for anyway.
void registerServiceWorker();
