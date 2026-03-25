import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/base/tokens.css';
import './styles/base/animations.css';
import './i18n'; // Must be imported before React renders
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
