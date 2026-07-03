import { useEffect, useState } from 'react';
import { PROTOCOL_VERSION } from '../../src/messaging/protocol';
import { createPortTransport } from '../../src/messaging/transport';

/** Phase-1 placeholder: proves the Port handshake works end to end. */
export function App() {
  const [status, setStatus] = useState('connecting…');

  useEffect(() => {
    const transport = createPortTransport();
    const off = transport.onEvent((ev) => {
      if (ev.type === 'initialized') {
        setStatus(`engine connected (protocol v${ev.protocolVersion})`);
      }
    });
    transport.send({
      type: 'initialize',
      submissionId: crypto.randomUUID(),
      protocolVersion: PROTOCOL_VERSION,
    });
    return () => {
      off();
      transport.close();
    };
  }, []);

  return (
    <div className="flex h-screen items-center justify-center bg-neutral-950 text-neutral-400">
      <div className="text-center">
        <div className="mb-2 text-lg font-semibold text-amber-500">Panelot</div>
        <div className="text-sm">{status}</div>
      </div>
    </div>
  );
}
