import type { PanelotDB } from '../db/schema';
import type { InteractionRecord, PendingToolExecution, RunRecord } from '../db/types';
import { ThreadTree, type AppendNodeInput } from '../db/tree';
import type {
  InteractionRequestPayload,
  InteractionResponse,
  PendingInteraction,
} from '../messaging/protocol';
import { interactionResultContent, interactionResultProvenance } from '../agent/interaction';
import { assertRunTransition } from './runState';
import {
  assertPreparedToolCall,
  persistStableToolCallNode,
  stablePersistenceKey,
} from './toolCallPersistence';
import {
  completeCommandReceiptInTransaction,
  type CommandTransactionContext,
} from './commandReceipts';

interface InteractionRepositoryOptions {
  now?: () => number;
}

export class InteractionRepository {
  private readonly now: () => number;

  constructor(
    private readonly db: PanelotDB,
    options: InteractionRepositoryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async createPendingWork(input: {
    id: string;
    threadId: string;
    runId: string;
    turnId: string;
    itemId: string;
    request: InteractionRequestPayload;
    pendingTool: PendingToolExecution;
    toolCallNode: AppendNodeInput;
  }): Promise<{ interaction: InteractionRecord; run: RunRecord }> {
    const toolCallNode = input.toolCallNode;
    assertPreparedToolCall(toolCallNode, input.pendingTool);
    return this.db.transaction(
      'rw',
      [this.db.interactions, this.db.runs, this.db.threads, this.db.nodes],
      async () => {
        const run = await this.db.runs.get(input.runId);
        if (!run || run.threadId !== input.threadId || run.turnId !== input.turnId) {
          throw new Error(`Run not found for interaction: ${input.id}`);
        }
        assertRunTransition(run.state, 'waiting_interaction');
        await persistStableToolCallNode(this.db, input.threadId, toolCallNode);
        const requestedAt = this.now();
        const interaction: InteractionRecord = {
          id: input.id,
          threadId: input.threadId,
          runId: input.runId,
          turnId: input.turnId,
          itemId: input.itemId,
          request: structuredClone(input.request),
          status: 'pending',
          requestedAt,
        };
        const updatedRun: RunRecord = {
          ...run,
          state: 'waiting_interaction',
          pendingTool: structuredClone(input.pendingTool),
          revision: run.revision + 1,
          updatedAt: requestedAt,
        };
        await this.db.interactions.add(interaction);
        await this.db.runs.put(updatedRun);
        return { interaction, run: updatedRun };
      },
    );
  }

  async resolve(
    id: string,
    response: InteractionResponse,
    command?: CommandTransactionContext,
  ): Promise<InteractionRecord> {
    if (command && command.commandType !== 'interaction.response') {
      throw new Error(
        `Invalid command transaction for interaction response: ${command.commandType}`,
      );
    }
    return this.db.transaction(
      'rw',
      [this.db.interactions, this.db.runs, this.db.threads, this.db.nodes, this.db.commandReceipts],
      async () => {
        const current = await this.db.interactions.get(id);
        if (!current) throw new Error(`Interaction not found: ${id}`);
        const run = await this.db.runs.get(current.runId);
        if (!run || run.threadId !== current.threadId) {
          throw new Error(`Run not found for interaction: ${id}`);
        }
        if (current.status === 'resolved') {
          if (command) {
            const receiptResponse =
              stablePersistenceKey(current.response) === stablePersistenceKey(response)
                ? {
                    type: 'command.ack' as const,
                    threadId: current.threadId,
                    runId: run.id,
                    revision: run.revision,
                  }
                : {
                    type: 'command.rejected' as const,
                    code: 'invalid_command',
                    message: `Interaction ${id} was already resolved with a different response.`,
                    threadId: current.threadId,
                    revision: run.revision,
                  };
            await completeCommandReceiptInTransaction(
              this.db,
              command,
              receiptResponse,
              this.now(),
            );
          }
          return current;
        }
        const respondedAt = this.now();
        const updated: InteractionRecord = {
          ...current,
          status: 'resolved',
          response: structuredClone(response),
          respondedAt,
        };
        await new ThreadTree(this.db).appendNode(current.threadId, {
          ts: respondedAt,
          type: 'interaction_response',
          payload: {
            interactionId: current.id,
            request: current.request,
            response,
            respondedAt,
          },
        });
        await this.db.interactions.put(updated);
        const updatedRun: RunRecord = {
          ...run,
          revision: run.revision + 1,
          updatedAt: respondedAt,
        };
        await this.db.runs.put(updatedRun);
        if (command) {
          await completeCommandReceiptInTransaction(
            this.db,
            command,
            {
              type: 'command.ack',
              threadId: current.threadId,
              runId: run.id,
              revision: updatedRun.revision,
            },
            respondedAt,
          );
        }
        return updated;
      },
    );
  }

  async claimResolvedContinuation(
    id: string,
  ): Promise<{ interaction: InteractionRecord; run: RunRecord } | null> {
    return this.db.transaction(
      'rw',
      [this.db.interactions, this.db.runs, this.db.threads, this.db.nodes],
      async () => {
        const interaction = await this.db.interactions.get(id);
        if (interaction?.status !== 'resolved' || !interaction.response) return null;
        const run = await this.db.runs.get(interaction.runId);
        if (
          !run ||
          run.threadId !== interaction.threadId ||
          run.turnId !== interaction.turnId ||
          run.state !== 'waiting_interaction' ||
          run.pendingTool?.itemId !== interaction.itemId
        ) {
          return null;
        }
        assertRunTransition(run.state, 'streaming_model');
        await new ThreadTree(this.db).appendNode(run.threadId, {
          type: 'tool_result',
          payload: {
            itemId: interaction.itemId,
            ok: interaction.request.kind !== 'mcp_elicitation',
            contentForLlm:
              interaction.request.kind === 'mcp_elicitation'
                ? [
                    {
                      type: 'text',
                      text: 'The MCP server elicitation was interrupted by runtime recovery, so the remote tool call did not receive the answer. Reissue the MCP tool only after checking that retrying is safe.',
                    },
                  ]
                : interactionResultContent(interaction.response),
            details: { interactionId: interaction.id, response: interaction.response },
            trust: 'trusted',
            provenance: interactionResultProvenance(interaction.request),
          },
        });
        const claimedAt = this.now();
        const claimed: RunRecord = {
          ...run,
          state: 'streaming_model',
          pendingTool: undefined,
          revision: run.revision + 1,
          updatedAt: claimedAt,
        };
        await this.db.runs.put(claimed);
        return { interaction, run: claimed };
      },
    );
  }

  async get(id: string): Promise<InteractionRecord | undefined> {
    return this.db.interactions.get(id);
  }

  async latestForRun(runId: string): Promise<InteractionRecord | undefined> {
    return this.db.interactions
      .where('runId')
      .equals(runId)
      .sortBy('requestedAt')
      .then((records) => records.at(-1));
  }

  async pendingForThread(threadId: string): Promise<PendingInteraction[]> {
    const records = await this.db.interactions
      .where('[threadId+status]')
      .equals([threadId, 'pending'])
      .sortBy('requestedAt');
    return records.map((record) => ({
      interactionId: record.id,
      turnId: record.turnId,
      itemId: record.itemId,
      request: record.request,
      requestedAt: record.requestedAt,
    }));
  }

  async pendingCountForThread(threadId: string): Promise<number> {
    return this.db.interactions.where('[threadId+status]').equals([threadId, 'pending']).count();
  }
}
