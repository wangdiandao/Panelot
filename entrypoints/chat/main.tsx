import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from '../sidepanel/App';
import '../../src/ui/styles/global.css';

// Phase 1: the chat tab reuses the handshake placeholder. Phase 5 gives it
// the three-column full-screen layout (docs/09 §3.1).
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
