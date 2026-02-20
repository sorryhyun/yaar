import React from 'react';
import ReactDOM from 'react-dom/client';
import './i18n'; // Must be imported before React renders
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
