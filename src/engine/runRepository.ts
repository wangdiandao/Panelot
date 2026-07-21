import type { PanelotDB } from '../db/schema';
import type {
  PendingToolExecution,
  ResolvedRunEnvironment,
  RunEnvironmentSnapshot,
  RunRecord,
  RunState,
  UserMessagePayload,
} from '../db/types';
import type { TurnOverrides, Usage, UserInput } from '../messaging/protocol';
import { ThreadTree, type AppendNodeInput } from '../db/tree';
import { assertRunTransition, recoverInterruptedRun } from './runState';
import { isRunEnvironmentSnapshot, resealRunEnvironmentSnapshot } from './runEnvironmentSnapshot';
import {
  assertPreparedToolCall,
  persistStableToolCallNode,
  stablePersistenceKey,
} from './toolCallPersistence';
import {
  completeCommandReceiptInTransaction,
  type CommandTransactionContext,
} from './commandReceipts';

interface RunRepositoryOptions {
  now?: () => number;
}

export interface EnqueueRunInput {
  threadId: string;
  clientId: string;
  submissionId: string;
  input: UserInput;
  overrides?: TurnOverrides;
}

export interface RunTransitionPatch {
  environment?: ResolvedRunEnvironment | RunEnvironmentSnapshot;
  stepCursor?: number;
  pendingTool?: PendingToolExecution;
  stopReason?: string;
  error?: { code: string; message: string };
}

export interface UpdateQueuedRunInput {
  input: UserInput;
  overrides?: TurnOverrides;
}

export interface AttachmentLink {
  attachmentIds: readonly string[];
  nodeId: string;
}

type PreparedToolRunState = 'waiting_approval' | 'waiting_interaction' | 'executing_tool';

export type RecoveredRun = RunRecord & {
  recoveryAction:
    | 'resume_run'
    | 'restore_approval'
    | 'restore_interaction'
    | 'replay_tool'
    | 'request_resolution'
    | 'request_resume'
    | 'none';
};

const terminalStates: readonly RunState[] = ['failed', 'completed'];
const closedSteerStates: readonly RunState[] = ['interrupted', 'failed', 'completed'];
const steerableStates: readonly RunState[] = [
  'preparing',
  'streaming_model',
  'waiting_approval',
  'waiting_interaction',
  'executing_tool',
];

export class RunRepository {
  private readonly now: () => number;

  constructor(
    private readonly db: PanelotDB,
    options: RunRepositoryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async enqueue(input: EnqueueRunInput, command?: CommandTransactionContext): Promise<RunRecord> {
    if (
      command &&
      command.commandType !== 'turn.enqueue' &&
      command.commandType !== 'turn.submit'
    ) {
      throw new Error(`Invalid command transaction for run enqueue: ${command.commandType}`);
    }
    const now = this.now();
    const run: RunRecord = {
      id: crypto.randomUUID(),
      threadId: input.threadId,
      turnId: crypto.randomUUID(),
      clientId: input.clientId,
      submissionId: input.submissionId,
      input: structuredClone(input.input),
      overrides: input.overrides ? structuredClone(input.overrides) : undefined,
      state: 'queued',
      revision: 0,
      stepCursor: 0,
      createdAt: now,
      updatedAt: now,
    };
    return this.db.transaction('rw', [this.db.runs, this.db.commandReceipts], async () => {
      await this.db.runs.add(run);
      if (command) {
        await completeCommandReceiptInTransaction(
          this.db,
          command,
          {
            type: 'command.ack',
            threadId: run.threadId,
            runId: run.id,
            revision: run.revision,
          },
          now,
        );
      }
      return run;
    });
  }

  async nextQueued(threadId: string): Promise<RunRecord | undefined> {
    return this.db.runs
      .where('[threadId+state]')
      .equals([threadId, 'queued'])
      .sortBy('createdAt')
      .then((records) => records[0]);
  }

  async countQueued(threadId: string): Promise<number> {
    return this.db.runs.where('[threadId+state]').equals([threadId, 'queued']).count();
  }

  async queuedForThread(threadId: string): Promise<RunRecord[]> {
    return this.db.runs.where('[threadId+state]').equals([threadId, 'queued']).sortBy('createdAt');
  }

  async recoverableForThread(threadId: string): Promise<RunRecord[]> {
    const states: readonly RunState[] = [
      'waiting_approval',
      'waiting_interaction',
      'paused_budget',
      'paused_uncertain',
      'interrupted',
    ];
    return this.db.runs
      .where('threadId')
      .equals(threadId)
      .filter((run) => states.includes(run.state))
      .sortBy('createdAt');
  }

  async updateQueued(
    id: string,
    patch: UpdateQueuedRunInput,
    command?: CommandTransactionContext,
  ): Promise<RunRecord> {
    if (command && command.commandType !== 'queue.update') {
      throw new Error(`Invalid command transaction for queue update: ${command.commandType}`);
    }
    return this.db.transaction('rw', [this.db.runs, this.db.commandReceipts], async () => {
      const current = await this.db.runs.get(id);
      if (!current) throw new Error(`Run not found: ${id}`);
      if (current.state !== 'queued') throw new Error(`Run ${id} is not queued`);
      const updated: RunRecord = {
        ...current,
        input: structuredClone(patch.input),
        overrides: patch.overrides ? structuredClone(patch.overrides) : undefined,
        revision: current.revision + 1,
        updatedAt: this.now(),
      };
      await this.db.runs.put(updated);
      if (command) {
        await completeCommandReceiptInTransaction(
          this.db,
          command,
          {
            type: 'command.ack',
            threadId: updated.threadId,
            runId: updated.id,
            revision: updated.revision,
          },
          updated.updatedAt,
        );
      }
      return updated;
    });
  }

  async removeQueued(id: string, command?: CommandTransactionContext): Promise<RunRecord> {
    if (command && command.commandType !== 'queue.remove') {
      throw new Error(`Invalid command transaction for queue removal: ${command.commandType}`);
    }
    return this.db.transaction('rw', [this.db.runs, this.db.commandReceipts], async () => {
      const current = await this.db.runs.get(id);
      if (!current) throw new Error(`Run not found: ${id}`);
      if (current.state !== 'queued') throw new Error(`Run ${id} is not queued`);
      const updated: RunRecord = {
        ...current,
        state: 'interrupted',
        stopReason: 'removed_from_queue',
        revision: current.revision + 1,
        updatedAt: this.now(),
      };
      await this.db.runs.put(updated);
      if (command) {
        await completeCommandReceiptInTransaction(
          this.db,
          command,
          {
            type: 'command.ack',
            threadId: updated.threadId,
            runId: updated.id,
            revision: updated.revision,
          },
          updated.updatedAt,
        );
      }
      return updated;
    });
  }

  async get(id: string): Promise<RunRecord | undefined> {
    return this.db.runs.get(id);
  }

  async prepare(
    id: string,
    environment: ResolvedRunEnvironment | RunEnvironmentSnapshot,
    normalizedInput?: UserInput,
    overrides?: TurnOverrides,
  ): Promise<RunRecord> {
    return this.db.transaction('rw', [this.db.runs, this.db.threads], async () => {
      const current = await this.db.runs.get(id);
      if (!current) throw new Error(`Run not found: ${id}`);
      assertRunTransition(current.state, 'preparing');
      const thread = await this.db.threads.get(current.threadId);
      if (!thread) throw new Error(`Thread not found: ${current.threadId}`);
      const updated: RunRecord = {
        ...current,
        environment,
        input: normalizedInput ? structuredClone(normalizedInput) : current.input,
        overrides: overrides ? structuredClone(overrides) : current.overrides,
        state: 'preparing',
        revision: current.revision + 1,
        updatedAt: this.now(),
      };
      await this.db.runs.put(updated);
      await this.db.threads.update(current.threadId, {
        stats: { ...thread.stats, turns: thread.stats.turns + 1 },
        revision: thread.revision + 1,
        updatedAt: this.now(),
      });
      return updated;
    });
  }

  async transition(
    id: string,
    state: RunState,
    patch: RunTransitionPatch = {},
  ): Promise<RunRecord> {
    return this.db.transaction('rw', this.db.runs, async () => {
      const current = await this.db.runs.get(id);
      if (!current) throw new Error(`Run not found: ${id}`);
      assertRunTransition(current.state, state);
      const updated: RunRecord = {
        ...current,
        ...patch,
        state,
        revision: current.revision + 1,
        updatedAt: this.now(),
      };
      await this.db.runs.put(updated);
      return updated;
    });
  }

  async appendNodeAndTransition(
    id: string,
    node: AppendNodeInput,
    state: RunState,
    patch: RunTransitionPatch = {},
    attachmentLink?: AttachmentLink,
  ): Promise<RunRecord> {
    return this.appendNodesAndTransition(id, [node], state, patch, attachmentLink);
  }

  async prepareToolCall(
    id: string,
    node: AppendNodeInput,
    state: PreparedToolRunState,
    pendingTool: PendingToolExecution,
  ): Promise<RunRecord> {
    assertPreparedToolCall(node, pendingTool);
    const nodeId = node.id;

    return this.db.transaction('rw', [this.db.runs, this.db.threads, this.db.nodes], async () => {
      const current = await this.db.runs.get(id);
      if (!current) throw new Error(`Run not found: ${id}`);
      const existing = await this.db.nodes.get(nodeId);
      if (existing) {
        await persistStableToolCallNode(this.db, current.threadId, node);
        if (
          current.state === state &&
          stablePersistenceKey(current.pendingTool) === stablePersistenceKey(pendingTool)
        ) {
          return current;
        }
        if (current.state === state) {
          throw new Error(`Prepared tool call pendingTool collision: ${nodeId}`);
        }
        const thread = await this.db.threads.get(current.threadId);
        if (thread?.leafId !== existing.id) {
          throw new Error(`Prepared tool call ${nodeId} is no longer the thread leaf`);
        }
      } else {
        await persistStableToolCallNode(this.db, current.threadId, node);
      }

      assertRunTransition(current.state, state);
      const updated: RunRecord = {
        ...current,
        state,
        pendingTool: structuredClone(pendingTool),
        revision: current.revision + 1,
        updatedAt: this.now(),
      };
      await this.db.runs.put(updated);
      return updated;
    });
  }

  async acceptSteer(
    id: string,
    node: AppendNodeInput,
    attachmentLink?: AttachmentLink,
    admissionSequence?: number,
  ): Promise<RunRecord> {
    return this.db.transaction('rw', [this.db.runs, this.db.attachments], async () => {
      const current = await this.db.runs.get(id);
      if (!current) throw new Error(`Run not found: ${id}`);
      if (!steerableStates.includes(current.state)) {
        throw new Error(`Run ${id} does not accept steering in state ${current.state}`);
      }
      if (node.type !== 'user_message' || !node.id) {
        throw new Error('Steer must be a user_message with a stable node id');
      }
      if (attachmentLink && node.id !== attachmentLink.nodeId) {
        throw new Error('Attachment link nodeId must match the appended node');
      }

      await this.linkAttachments(current, attachmentLink);

      const updated: RunRecord = {
        ...current,
        pendingSteers: [
          ...(current.pendingSteers ?? []),
          {
            nodeId: node.id,
            payload: structuredClone(node.payload as UserMessagePayload),
            attachmentIds: attachmentLink?.attachmentIds
              ? [...attachmentLink.attachmentIds]
              : undefined,
            acceptedAt: this.now(),
            admissionSequence:
              admissionSequence ??
              (current.pendingSteers ?? []).reduce(
                (maximum, steer) => Math.max(maximum, steer.admissionSequence ?? -1),
                -1,
              ) + 1,
          },
        ],
        revision: current.revision + 1,
        updatedAt: this.now(),
      };
      await this.db.runs.put(updated);
      return updated;
    });
  }

  async materializeSteers(id: string, nodeIds: readonly string[]): Promise<RunRecord> {
    return this.db.transaction('rw', [this.db.runs, this.db.threads, this.db.nodes], async () => {
      const current = await this.db.runs.get(id);
      if (!current) throw new Error(`Run not found: ${id}`);
      if (closedSteerStates.includes(current.state)) {
        throw new Error(`Run ${id} is terminal in state ${current.state}`);
      }
      const requested = new Set(nodeIds);
      const pending = current.pendingSteers ?? [];
      const pendingById = new Map(pending.map((steer) => [steer.nodeId, steer]));
      const selected = nodeIds.map((nodeId) => pendingById.get(nodeId));
      if (selected.some((steer) => !steer) || selected.length !== requested.size) {
        throw new Error(`Run ${id} has missing pending steer nodes`);
      }
      const tree = new ThreadTree(this.db);
      for (const steer of selected) {
        if (!steer) continue;
        await tree.appendNode(current.threadId, {
          id: steer.nodeId,
          type: 'user_message',
          payload: steer.payload,
        });
      }
      const updated: RunRecord = {
        ...current,
        pendingSteers: pending.filter((steer) => !requested.has(steer.nodeId)),
        revision: current.revision + 1,
        updatedAt: this.now(),
      };
      await this.db.runs.put(updated);
      return updated;
    });
  }

  async appendNodesAndTransition(
    id: string,
    nodes: readonly AppendNodeInput[],
    state: RunState,
    patch: RunTransitionPatch = {},
    attachmentLink?: AttachmentLink,
  ): Promise<RunRecord> {
    if (
      nodes.length === 1 &&
      nodes[0]?.type === 'tool_call' &&
      patch.pendingTool &&
      (state === 'waiting_approval' ||
        state === 'waiting_interaction' ||
        state === 'executing_tool')
    ) {
      return this.prepareToolCall(id, nodes[0], state, patch.pendingTool);
    }
    return this.db.transaction(
      'rw',
      [this.db.runs, this.db.threads, this.db.nodes, this.db.attachments],
      async () => {
        const current = await this.db.runs.get(id);
        if (!current) throw new Error(`Run not found: ${id}`);
        assertRunTransition(current.state, state);

        const tree = new ThreadTree(this.db);
        for (const node of nodes) await tree.appendNode(current.threadId, node);

        await this.linkAttachments(current, attachmentLink);

        const updated: RunRecord = {
          ...current,
          ...patch,
          state,
          revision: current.revision + 1,
          updatedAt: this.now(),
        };
        await this.db.runs.put(updated);
        return updated;
      },
    );
  }

  private async linkAttachments(run: RunRecord, attachmentLink?: AttachmentLink): Promise<void> {
    if (!attachmentLink) return;
    for (const attachmentId of attachmentLink.attachmentIds) {
      const attachment = await this.db.attachments.get(attachmentId);
      if (!attachment || attachment.threadId !== run.threadId) {
        throw new Error(`Attachment not found in run thread: ${attachmentId}`);
      }
      if (attachment.provenance !== 'user') {
        throw new Error(`Attachment is not a user upload: ${attachmentId}`);
      }
      await this.db.attachments.update(attachmentId, {
        refs: {
          ...attachment.refs,
          nodeIds: [...new Set([...(attachment.refs?.nodeIds ?? []), attachmentLink.nodeId])],
          runIds: [...new Set([...(attachment.refs?.runIds ?? []), run.id])],
        },
      });
    }
  }

  async appendAssistantAndCommitUsage(
    id: string,
    node: AppendNodeInput,
    usage: Usage,
    costUsd: number,
    state: RunState,
    patch: RunTransitionPatch = {},
  ): Promise<RunRecord> {
    if (node.type !== 'assistant_message') {
      throw new Error('Usage can only be committed with an assistant message');
    }
    return this.db.transaction('rw', [this.db.runs, this.db.threads, this.db.nodes], async () => {
      const current = await this.db.runs.get(id);
      if (!current) throw new Error(`Run not found: ${id}`);
      assertRunTransition(current.state, state);
      await new ThreadTree(this.db).appendNode(current.threadId, node);
      const thread = await this.db.threads.get(current.threadId);
      if (!thread) throw new Error(`Thread not found: ${current.threadId}`);

      const cumulative: Usage = {
        input: (current.usage?.input ?? 0) + usage.input,
        output: (current.usage?.output ?? 0) + usage.output,
        ...(current.usage?.cacheRead !== undefined || usage.cacheRead !== undefined
          ? { cacheRead: (current.usage?.cacheRead ?? 0) + (usage.cacheRead ?? 0) }
          : {}),
      };
      const updated: RunRecord = {
        ...current,
        ...patch,
        state,
        usage: cumulative,
        costUsd: (current.costUsd ?? 0) + costUsd,
        revision: current.revision + 1,
        updatedAt: this.now(),
      };
      await this.db.runs.put(updated);
      await this.db.threads.update(current.threadId, {
        stats: {
          ...thread.stats,
          totalTokens: thread.stats.totalTokens + usage.input + usage.output,
          costUsd: thread.stats.costUsd + costUsd,
        },
        revision: thread.revision + 1,
        updatedAt: this.now(),
      });
      return updated;
    });
  }

  async recoverOpenRuns(): Promise<RecoveredRun[]> {
    return this.db.transaction('rw', this.db.runs, async () => {
      const open = (await this.db.runs.toArray()).filter(
        (run) => !terminalStates.includes(run.state),
      );
      const recovered: RecoveredRun[] = [];
      for (const run of open) {
        const decision = recoverInterruptedRun({
          state: run.state,
          pendingTool: run.pendingTool,
        });
        const updated: RunRecord = {
          ...run,
          state: decision.state,
          revision: run.revision + (decision.state === run.state ? 0 : 1),
          updatedAt: this.now(),
        };
        await this.db.runs.put(updated);
        recovered.push({ ...updated, recoveryAction: decision.action });
      }
      return recovered;
    });
  }

  async commitUsage(id: string, usage: Usage, costUsd = 0): Promise<RunRecord> {
    return this.db.transaction('rw', [this.db.runs, this.db.threads], async () => {
      const run = await this.db.runs.get(id);
      if (!run) throw new Error(`Run not found: ${id}`);
      const thread = await this.db.threads.get(run.threadId);
      if (!thread) throw new Error(`Thread not found: ${run.threadId}`);

      const cumulative: Usage = {
        input: (run.usage?.input ?? 0) + usage.input,
        output: (run.usage?.output ?? 0) + usage.output,
        ...(run.usage?.cacheRead !== undefined || usage.cacheRead !== undefined
          ? { cacheRead: (run.usage?.cacheRead ?? 0) + (usage.cacheRead ?? 0) }
          : {}),
      };
      const updated: RunRecord = {
        ...run,
        usage: cumulative,
        costUsd: (run.costUsd ?? 0) + costUsd,
        revision: run.revision + 1,
        updatedAt: this.now(),
      };
      await this.db.runs.put(updated);
      await this.db.threads.update(run.threadId, {
        stats: {
          ...thread.stats,
          totalTokens: thread.stats.totalTokens + usage.input + usage.output,
          costUsd: thread.stats.costUsd + costUsd,
        },
        revision: thread.revision + 1,
        updatedAt: this.now(),
      });
      return updated;
    });
  }

  async activateSkill(id: string, skillId: string): Promise<RunRecord> {
    return this.db.transaction('rw', this.db.runs, async () => {
      const run = await this.db.runs.get(id);
      if (!run?.environment) throw new Error(`Run environment not found: ${id}`);
      if (run.environment.activeSkills.includes(skillId)) return run;
      const environment = isRunEnvironmentSnapshot(run.environment)
        ? await resealRunEnvironmentSnapshot({
            ...run.environment,
            activeSkills: [...run.environment.activeSkills, skillId],
          })
        : {
            ...run.environment,
            activeSkills: [...run.environment.activeSkills, skillId],
          };
      const updated: RunRecord = {
        ...run,
        environment,
        revision: run.revision + 1,
        updatedAt: this.now(),
      };
      await this.db.runs.put(updated);
      return updated;
    });
  }
}
