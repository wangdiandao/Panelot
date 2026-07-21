export interface McpWorkerSessionClient {
  close(): Promise<void>;
}

export interface McpWorkerConnectionLease {
  serverId: string;
  connectionId: string;
  generation: number;
}

interface WorkerSession<TClient> {
  connectionId: string;
  client: TClient;
}

interface ConnectionOwner {
  connectionId: string;
  generation: number;
}

interface ActiveToolCall {
  serverId: string;
  connectionId: string;
  controller: AbortController;
}

interface PendingCancellation {
  serverId: string;
  connectionId: string;
  expiresAt: number;
}

const CANCEL_TOMBSTONE_TTL_MS = 30_000;
const MAX_CANCEL_TOMBSTONES = 1_024;

/**
 * Owns the offscreen worker's per-server connection and tool-call identities.
 * Connection leases prevent a slower handshake from replacing a newer owner,
 * while short-lived cancellation tombstones cover cancel-before-admission races.
 */
export class McpWorkerSessions<TClient extends McpWorkerSessionClient> {
  private readonly sessions = new Map<string, WorkerSession<TClient>>();
  private readonly owners = new Map<string, ConnectionOwner>();
  private readonly activeToolCalls = new Map<string, ActiveToolCall>();
  private readonly pendingCancellations = new Map<string, PendingCancellation>();

  claimConnection(
    serverId: string,
    connectionId: string,
  ): { lease: McpWorkerConnectionLease; previous?: WorkerSession<TClient> } {
    const previousOwner = this.owners.get(serverId);
    const lease = {
      serverId,
      connectionId,
      generation: (previousOwner?.generation ?? 0) + 1,
    };
    this.owners.set(serverId, lease);

    const previous = this.sessions.get(serverId);
    if (previous) {
      this.sessions.delete(serverId);
      this.clearConnectionOperations(serverId, previous.connectionId);
    }
    return { lease, previous };
  }

  commitConnection(lease: McpWorkerConnectionLease, client: TClient): boolean {
    if (!this.isCurrentOwner(lease)) return false;
    this.sessions.set(lease.serverId, { connectionId: lease.connectionId, client });
    return true;
  }

  closeConnection(serverId: string, connectionId: string): { owned: boolean; client?: TClient } {
    const owner = this.owners.get(serverId);
    if (owner?.connectionId !== connectionId) return { owned: false };

    this.owners.delete(serverId);
    const session = this.sessions.get(serverId);
    if (session?.connectionId === connectionId) this.sessions.delete(serverId);
    this.clearConnectionOperations(serverId, connectionId);
    return {
      owned: true,
      ...(session?.connectionId === connectionId ? { client: session.client } : {}),
    };
  }

  getClient(serverId: string, connectionId: string): TClient | undefined {
    const session = this.sessions.get(serverId);
    return session?.connectionId === connectionId ? session.client : undefined;
  }

  claimToolCall(serverId: string, connectionId: string, operationId: string): AbortController {
    this.pruneCancellationTombstones();
    const key = toolCallKey(serverId, connectionId, operationId);
    if (this.activeToolCalls.has(key)) throw new Error('MCP operation id is already active');

    const controller = new AbortController();
    if (this.pendingCancellations.delete(key)) {
      controller.abort();
      return controller;
    }
    this.activeToolCalls.set(key, { serverId, connectionId, controller });
    return controller;
  }

  finishToolCall(
    serverId: string,
    connectionId: string,
    operationId: string,
    controller: AbortController,
  ): void {
    const key = toolCallKey(serverId, connectionId, operationId);
    if (this.activeToolCalls.get(key)?.controller === controller) this.activeToolCalls.delete(key);
  }

  cancelToolCall(serverId: string, connectionId: string, operationId: string): void {
    this.pruneCancellationTombstones();
    const key = toolCallKey(serverId, connectionId, operationId);
    const active = this.activeToolCalls.get(key)?.controller;
    if (active) {
      active.abort();
      return;
    }

    this.pendingCancellations.delete(key);
    this.pendingCancellations.set(key, {
      serverId,
      connectionId,
      expiresAt: Date.now() + CANCEL_TOMBSTONE_TTL_MS,
    });
    while (this.pendingCancellations.size > MAX_CANCEL_TOMBSTONES) {
      const oldest = this.pendingCancellations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.pendingCancellations.delete(oldest);
    }
  }

  private isCurrentOwner(lease: McpWorkerConnectionLease): boolean {
    const owner = this.owners.get(lease.serverId);
    return owner?.connectionId === lease.connectionId && owner.generation === lease.generation;
  }

  private clearConnectionOperations(serverId: string, connectionId: string): void {
    for (const [key, active] of this.activeToolCalls) {
      if (active.serverId !== serverId || active.connectionId !== connectionId) continue;
      this.activeToolCalls.delete(key);
      active.controller.abort();
    }
    for (const [key, pending] of this.pendingCancellations) {
      if (pending.serverId === serverId && pending.connectionId === connectionId) {
        this.pendingCancellations.delete(key);
      }
    }
  }

  private pruneCancellationTombstones(now = Date.now()): void {
    for (const [key, pending] of this.pendingCancellations) {
      if (pending.expiresAt <= now) this.pendingCancellations.delete(key);
    }
  }
}

function toolCallKey(serverId: string, connectionId: string, operationId: string): string {
  return JSON.stringify([serverId, connectionId, operationId]);
}
