import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { bootstrapLanguage } from '../../src/ui/i18n';
import '../../src/ui/styles/global.css';

void bootstrapLanguage().then((stopLanguageSync) => {
  window.addEventListener('pagehide', stopLanguageSync, { once: true });
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root mount element');
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
