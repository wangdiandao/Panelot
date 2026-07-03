import React from 'react';
import ReactDOM from 'react-dom/client';
import '../../src/ui/styles/global.css';

function OptionsApp() {
  return (
    <div className="flex h-screen items-center justify-center text-neutral-400">
      Settings — built in Phase 5.
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OptionsApp />
  </React.StrictMode>,
);
