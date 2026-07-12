import React from 'react';
import ReactDOM from 'react-dom/client';
import '../../src/ui/styles/global.css';

void import('./App').then(({ App }) => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
