import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/base/tokens.css';
import './i18n'; // Must be imported before React renders
import App from './App';
import { registerServiceWorker } from './lib/registerServiceWorker';
import { injectScriptOnce } from './lib/injectScriptOnce';
import { IFRAME_AUTOFILL_GUARD_SCRIPT } from '@yaar/shared';

// The same opt-out app frames get, for the shell's own fields (palette, dialogs,
// component-DSL inputs) — before the first render, so no field is seen unstamped.
injectScriptOnce(document, 'data-yaar-autofill-guard', IFRAME_AUTOFILL_GUARD_SCRIPT);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// After the first render, never before it: the desktop must not wait on the shell cache,
// and on an insecure origin there is no worker to wait for anyway.
void registerServiceWorker();
