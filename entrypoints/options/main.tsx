import React from 'react';
import ReactDOM from 'react-dom/client';
import { bootstrapLanguage } from '../../src/ui/i18n';
import '../../src/ui/styles/global.css';

void Promise.all([bootstrapLanguage(), import('./App')]).then(([stopLanguageSync, { App }]) => {
  window.addEventListener('pagehide', stopLanguageSync, { once: true });
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
