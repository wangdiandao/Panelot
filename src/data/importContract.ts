import type { MemoryRecord, SkillRecord, ThreadMeta, ThreadNode } from '../db/types';
import type { EncryptedSecretBackup } from '../security/secretStore';

export const IMPORT_SETTINGS_KEYS = [
  'connections',
  'model_presets',
  'global_settings',
  'permission_rules',
  'sensitive_origins',
  'mcp_servers',
  'site_prompts',
] as const;

export interface CanonicalImportPlan {
  version: 1;
  exportedAt: number;
  threads: ThreadMeta[];
  nodes: ThreadNode[];
  skills: SkillRecord[];
  memories: MemoryRecord[];
  settings: Record<string, unknown>;
  secretBackupDigest?: string;
}

export interface ExportBundle {
  version: 2;
  exportedAt: number;
  threads: ThreadMeta[];
  nodes: ThreadNode[];
  skills: SkillRecord[];
  memories: MemoryRecord[];
  settings: Record<string, unknown>;
  encryptedSecrets?: EncryptedSecretBackup;
}

export interface ImportValidationResult {
  bytes: number;
  threadCount: number;
  nodeCount: number;
  skillCount: number;
  memoryCount: number;
  hasEncryptedSecrets: boolean;
}
