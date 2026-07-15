import type { AgentEvent } from './protocol';

/** One connected client, as seen by the engine. */
export interface EngineConnection {
  post(event: AgentEvent): void;
  onOp(callback: (operation: unknown) => void): void;
  onClose(callback: () => void): void;
  close(): void;
}

/** The engine implements this; transports call it for each new client. */
export type ConnectionHandler = (connection: EngineConnection) => void;

export const ENGINE_PORT_NAME = 'panelot-engine';

/** Engine-side wrapper for an incoming chrome.runtime Port. */
export function wrapPortConnection(port: chrome.runtime.Port): EngineConnection {
  return {
    post(event) {
      try {
        port.postMessage(event);
      } catch {
        // Port already gone; onDisconnect will fire.
      }
    },
    onOp(callback) {
      port.onMessage.addListener((message) => callback(message));
    },
    onClose(callback) {
      port.onDisconnect.addListener(() => callback());
    },
    close() {
      port.disconnect();
    },
  };
}

/**
 * Wraps a Port before the engine is ready without losing messages that arrive
 * between onConnect and EngineHost installing its operation handler.
 */
export function wrapBufferedPortConnection(
  port: chrome.runtime.Port,
  maxPending = 32,
): EngineConnection {
  let operationHandler: ((operation: unknown) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  let closed = false;
  let closeNotified = false;
  const pending: unknown[] = [];

  const notifyClose = () => {
    if (!closeHandler || closeNotified) return;
    closeNotified = true;
    closeHandler();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    pending.length = 0;
    try {
      port.disconnect();
    } finally {
      notifyClose();
    }
  };

  port.onMessage.addListener((message) => {
    if (closed) return;
    if (operationHandler) {
      operationHandler(message);
      return;
    }
    if (pending.length >= maxPending) {
      close();
      return;
    }
    pending.push(message);
  });
  port.onDisconnect.addListener(() => {
    closed = true;
    pending.length = 0;
    notifyClose();
  });

  return {
    post(event) {
      if (closed) return;
      try {
        port.postMessage(event);
      } catch {
        close();
      }
    },
    onOp(callback) {
      operationHandler = callback;
      if (closed) return;
      for (const message of pending.splice(0)) callback(message);
    },
    onClose(callback) {
      closeHandler = callback;
      if (closed && !closeNotified) queueMicrotask(notifyClose);
    },
    close,
  };
}
