import type { PanelotDB } from '../db/schema';
import { secretStore } from '../security/secretStore';
import type { ExportBundle, ImportValidationResult } from './exportImport';
import { validateImportBundle } from './exportImport';
import type { CanonicalImportPlan } from './importContract';

export async function prepareCanonicalImport(
  db: PanelotDB,
  input: unknown,
  passphrase?: string,
): Promise<{
  bundle: ExportBundle;
  plan: CanonicalImportPlan;
  report: ImportValidationResult;
}> {
  const { bundle, report } = await validateImportBundle(db, input, { merge: false });
  if (bundle.encryptedSecrets) {
    if (!passphrase) throw new Error('该备份包含加密秘密，请输入备份口令');
    await secretStore.decryptBackup(bundle.encryptedSecrets, passphrase);
  }
  const secretBackupDigest = bundle.encryptedSecrets
    ? await digest(bundle.encryptedSecrets)
    : undefined;
  return {
    bundle,
    report,
    plan: {
      version: 1,
      exportedAt: bundle.exportedAt,
      threads: bundle.threads,
      nodes: bundle.nodes,
      skills: bundle.skills as CanonicalImportPlan['skills'],
      memories: bundle.memories as CanonicalImportPlan['memories'],
      settings: bundle.settings,
      ...(secretBackupDigest ? { secretBackupDigest } : {}),
    },
  };
}

async function digest(value: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
