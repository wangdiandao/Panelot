import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { bootstrapLanguage } from '../../src/ui/i18n';
import '../../src/ui/styles/global.css';

void bootstrapLanguage().then((stopLanguageSync) => {
  window.addEventListener('pagehide', stopLanguageSync, { once: true });
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
