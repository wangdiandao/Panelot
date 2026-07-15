import type { Attachment, SkillRecord, ThreadNode, UserMessagePayload } from '../db/types';
import type { ExportBundle } from './importContract';

export interface MaintenancePlan {
  bundle: ExportBundle;
  portableSkills: SkillRecord[];
  digest: string;
}

export interface MaintenanceValidator {
  buildPlan(input: unknown, operationId: string): Promise<MaintenancePlan>;
  validateMaterialized(
    settings: Record<string, unknown>,
    localSecretKey: unknown,
    existingKey: unknown,
    plannedSettings: Record<string, unknown>,
  ): Promise<void>;
}

export function assertSkillCollisions(
  imported: readonly SkillRecord[],
  preserved: readonly SkillRecord[],
): void {
  const ids = new Set(preserved.map((skill) => skill.id));
  const names = new Set(preserved.map((skill) => skill.name));
  if (imported.some((skill) => ids.has(skill.id) || names.has(skill.name))) {
    throw new Error('IMPORT_SKILL_COLLISION');
  }
}

export function reconcileImportedAttachments(
  nodes: readonly ThreadNode[],
  attachments: readonly Attachment[],
  now: number,
): { nodes: ThreadNode[]; attachments: Attachment[] } {
  const copies = nodes.map((node) => structuredClone(node));
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const refs = new Map<string, { nodeId: string; threadId: string }[]>();
  for (const node of copies) {
    if (node.type !== 'user_message') continue;
    for (const block of (node.payload as UserMessagePayload).attachedContext ?? []) {
      if (
        block.kind !== 'file' ||
        block.provenance !== 'user' ||
        typeof block.sourceRef !== 'string'
      ) {
        continue;
      }
      const list = refs.get(block.sourceRef) ?? [];
      list.push({ nodeId: node.id, threadId: node.threadId });
      refs.set(block.sourceRef, list);
      if (byId.get(block.sourceRef)?.threadId !== node.threadId) node.evicted = true;
    }
  }
  return {
    nodes: copies,
    attachments: attachments.map((attachment) => {
      const matches = (refs.get(attachment.id) ?? []).filter(
        (ref) => ref.threadId === attachment.threadId,
      );
      const next: Attachment = {
        ...attachment,
        refs: {
          ...(attachment.refs?.pluginId ? { pluginId: attachment.refs.pluginId } : {}),
          nodeIds: matches.map((ref) => ref.nodeId),
          runIds: [],
        },
      };
      if (!matches.length && !attachment.refs?.pluginId) {
        next.orphanedAt = now;
        next.detachedReason = 'overwrite-import';
      } else {
        delete next.orphanedAt;
        delete next.detachedReason;
      }
      return next;
    }),
  };
}

export async function maintenanceDigest(value: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
