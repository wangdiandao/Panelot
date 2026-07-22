/**
 * Data settings (docs/development/index.md §5; docs/development/ui.md §3.4): full JSON
 * export/import (keys stripped by default), storage usage display, quota warning. Built on
 * shadcn/ui primitives.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { Input } from '../components/ui/input';
import { Progress } from '../components/ui/progress';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../components/ui/alert';
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '../components/ui/field';
import { FilePickerButton } from '../components/FilePickerButton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { PanelotDB } from '../../db/schema';
import {
  exportAll,
  materializeImportSettings,
  validateImportBundle,
  type ExportBundle,
  type ImportValidationResult,
} from '../../data/exportImport';
import { prepareCanonicalImport } from '../../data/maintenancePlan';
import type { DataImportCommitResult } from '../../data/maintenanceTypes';
import type { DataImportCoordinatorPreview } from '../../data/maintenanceCoordinator';
import {
  DATA_IMPORT_RPC_TYPE,
  sendDataImportRpc,
  type DataImportMaintenanceStatus,
} from '../../data/maintenanceRpc';
import { getQuotaStatus, type QuotaStatus } from '../../data/quota';
import { t } from '../i18n';

const db = new PanelotDB();

type PreparedImport = Awaited<ReturnType<typeof prepareCanonicalImport>>;

export function DataPage() {
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [includeKeys, setIncludeKeys] = useState(false);
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [exportAttempted, setExportAttempted] = useState(false);
  const [importPassphrase, setImportPassphrase] = useState('');
  const [pendingImport, setPendingImport] = useState<ExportBundle | null>(null);
  const [importReport, setImportReport] = useState<ImportValidationResult | null>(null);
  const [operationId, setOperationId] = useState('');
  const [preparedImport, setPreparedImport] = useState<PreparedImport | null>(null);
  const [preview, setPreview] = useState<DataImportCoordinatorPreview | null>(null);
  const [confirmDormant, setConfirmDormant] = useState(false);
  const [busy, setBusy] = useState(false);
  const [maintenance, setMaintenance] = useState<DataImportMaintenanceStatus | null>(null);
  const [reloadRequired, setReloadRequired] = useState(false);

  useEffect(() => {
    void getQuotaStatus().then(setQuota);
    void loadMaintenanceStatus()
      .then(setMaintenance)
      .catch(() => undefined);
  }, []);

  const doExport = async () => {
    setExportAttempted(true);
    if (includeKeys && !backupPassphrase) {
      toast.error(t('settings.data.passphraseRequired'));
      return;
    }
    const bundle = await exportAll(db, {
      secretBackupPassphrase: includeKeys ? backupPassphrase : undefined,
    });
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `panelot-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setExportAttempted(false);
    toast.success(t('settings.data.exported'));
  };

  const resetImport = () => {
    setPendingImport(null);
    setImportReport(null);
    setPreparedImport(null);
    setPreview(null);
    setConfirmDormant(false);
    setImportPassphrase('');
    setOperationId('');
  };

  const stageImport = async (file: File) => {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const validated = await validateImportBundle(db, parsed, { merge: false });
      setPendingImport(validated.bundle);
      setImportReport(validated.report);
      setPreparedImport(null);
      setPreview(null);
      setConfirmDormant(false);
      setOperationId(crypto.randomUUID());
    } catch (error) {
      toast.error(t('settings.data.importFailed', { error: errorMessage(error) }));
    }
  };

  const previewImport = async () => {
    if (!pendingImport || !operationId) return;
    setBusy(true);
    try {
      const prepared = await prepareCanonicalImport(
        db,
        pendingImport,
        pendingImport.encryptedSecrets ? importPassphrase : undefined,
      );
      const result = await sendDataImportRpc<DataImportCoordinatorPreview>({
        type: DATA_IMPORT_RPC_TYPE,
        action: 'preview',
        operationId,
        input: prepared.plan,
      });
      setPreparedImport(prepared);
      setImportReport(prepared.report);
      setPreview(result);
      setConfirmDormant(false);
    } catch (error) {
      toast.error(t('settings.data.importFailed', { error: errorMessage(error) }));
    } finally {
      setBusy(false);
    }
  };

  const commitImport = async () => {
    if (!preparedImport || !preview) return;
    setBusy(true);
    try {
      const materialized = await materializeImportSettings(
        preparedImport.bundle,
        preparedImport.bundle.encryptedSecrets ? importPassphrase : undefined,
      );
      const result = await sendDataImportRpc<DataImportCommitResult>({
        type: DATA_IMPORT_RPC_TYPE,
        action: 'commit',
        operationId: preview.operationId,
        input: preparedImport.plan,
        expectedDigest: preview.digest,
        settings: materialized.settings,
        oauthAccessToClear: materialized.oauthAccessToClear,
        ...(materialized.localSecretKey ? { localSecretKey: materialized.localSecretKey } : {}),
        ...(confirmDormant ? { confirmDiscardDormant: true } : {}),
      });
      if (result.status === 'blocked') {
        setPreview({ ...preview, blockers: result.blockers });
        setConfirmDormant(false);
        return;
      }
      setReloadRequired(true);
      toast.success(t('settings.data.committed'));
      resetImport();
      setMaintenance(await loadMaintenanceStatus());
    } catch (error) {
      toast.error(t('settings.data.importFailed', { error: errorMessage(error) }));
      setMaintenance(await loadMaintenanceStatus().catch(() => null));
    } finally {
      setBusy(false);
    }
  };

  const blockerCounts = preview ? summarizeBlockers(preview) : null;
  const dormantConfirmed = !preview?.blockers.requiresDormantConfirmation || confirmDormant;

  return (
    <div className="flex max-w-xl flex-col gap-5">
      <h2 className="text-[15px] font-semibold">{t('settings.section.data')}</h2>

      {(reloadRequired || maintenance?.blocked) && (
        <Alert variant="destructive" aria-live="polite">
          <AlertTitle>{t('settings.data.reloadRequired')}</AlertTitle>
          <AlertDescription>{t('settings.data.reloadRequiredHint')}</AlertDescription>
          <AlertAction>
            <Button size="sm" variant="destructive" onClick={() => chrome.runtime.reload()}>
              {t('settings.data.reloadNow')}
            </Button>
          </AlertAction>
        </Alert>
      )}
      {!maintenance?.blocked && maintenance?.reconciliation === 'rolled_back' && (
        <Alert>
          <AlertDescription>{t('settings.data.rollbackRecovered')}</AlertDescription>
        </Alert>
      )}
      {!maintenance?.blocked && maintenance?.reconciliation === 'rolled_forward' && (
        <Alert>
          <AlertDescription>{t('settings.data.commitRecovered')}</AlertDescription>
        </Alert>
      )}

      {quota && (
        <div className="flex flex-col gap-1">
          <div className="flex justify-between text-[12px] text-muted-foreground">
            <span>{t('settings.data.usage')}</span>
            <span>
              {(quota.usage / 1024 / 1024).toFixed(1)} MB / {(quota.quota / 1024 / 1024).toFixed(0)}{' '}
              MB（{Math.round(quota.pct * 100)}%）
            </span>
          </div>
          <Progress
            value={Math.round(quota.pct * 100)}
            aria-label={t('settings.data.usage')}
            aria-invalid={quota.warn || undefined}
            variant={quota.warn ? 'destructive' : 'default'}
          />
          {quota.warn && (
            <div className="text-[11px] text-destructive">{t('settings.data.nearLimit')}</div>
          )}
        </div>
      )}

      <FieldSet>
        <FieldLegend variant="label">{t('settings.data.export')}</FieldLegend>
        <FieldGroup className="gap-3">
          <Field orientation="horizontal">
            <Checkbox
              id="include-secret-keys"
              checked={includeKeys}
              onCheckedChange={(on) => setIncludeKeys(on === true)}
            />
            <FieldLabel htmlFor="include-secret-keys">
              {t('settings.data.includeSecrets')}
            </FieldLabel>
          </Field>
          {includeKeys && (
            <Field data-invalid={exportAttempted && !backupPassphrase}>
              <FieldLabel htmlFor="backup-passphrase">{t('settings.data.passphrase')}</FieldLabel>
              <Input
                id="backup-passphrase"
                type="password"
                value={backupPassphrase}
                onChange={(event) => setBackupPassphrase(event.target.value)}
                aria-invalid={exportAttempted && !backupPassphrase}
                placeholder={t('settings.data.passphrase')}
                aria-label={t('settings.data.passphrase')}
                autoComplete="new-password"
              />
              {exportAttempted && !backupPassphrase && (
                <FieldError>{t('settings.data.passphraseRequired')}</FieldError>
              )}
            </Field>
          )}
          <Button size="sm" className="w-fit" onClick={() => void doExport()}>
            {t('settings.data.exportAll')}
          </Button>
        </FieldGroup>
      </FieldSet>

      <FieldSet>
        <FieldLegend variant="label">{t('settings.data.import')}</FieldLegend>
        <FieldGroup>
          <Field>
            <FilePickerButton
              id="data-json-import"
              label={t('settings.data.chooseJsonLabel')}
              accept=".json"
              onFile={(file) => void stageImport(file)}
            >
              {t('settings.data.chooseJson')}
            </FilePickerButton>
          </Field>
        </FieldGroup>
      </FieldSet>

      <AlertDialog
        open={pendingImport !== null}
        onOpenChange={(open) => {
          if (!open && !busy) resetImport();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.data.overwriteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.data.overwriteHint', {
                threads: importReport?.threadCount ?? 0,
                nodes: importReport?.nodeCount ?? 0,
                skills: importReport?.skillCount ?? 0,
                size: ((importReport?.bytes ?? 0) / 1024).toFixed(1),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingImport?.encryptedSecrets && (
            <Field>
              <FieldLabel htmlFor="import-passphrase">
                {t('settings.data.enterPassphrase')}
              </FieldLabel>
              <Input
                id="import-passphrase"
                type="password"
                value={importPassphrase}
                onChange={(event) => {
                  setImportPassphrase(event.target.value);
                  setPreparedImport(null);
                  setPreview(null);
                  setConfirmDormant(false);
                }}
                placeholder={t('settings.data.enterPassphrase')}
                aria-label={t('settings.data.enterPassphrase')}
                autoComplete="current-password"
              />
            </Field>
          )}
          {blockerCounts && (
            <Alert
              variant={preview?.blockers.hardBlocked ? 'destructive' : 'default'}
              aria-live="polite"
            >
              <AlertTitle>
                {preview?.blockers.hardBlocked
                  ? t('settings.data.previewBlocked')
                  : t('settings.data.previewReady')}
              </AlertTitle>
              <AlertDescription>
                {t('settings.data.blockerSummary', blockerCounts)}
              </AlertDescription>
              {preview?.blockers.requiresDormantConfirmation && !preview.blockers.hardBlocked && (
                <Field orientation="horizontal">
                  <Checkbox
                    id="confirm-dormant-import"
                    checked={confirmDormant}
                    onCheckedChange={(checked) => setConfirmDormant(checked === true)}
                  />
                  <FieldLabel htmlFor="confirm-dormant-import">
                    {t('settings.data.confirmDormant')}
                  </FieldLabel>
                </Field>
              )}
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('app.cancel')}</AlertDialogCancel>
            {!preview || preview.blockers.hardBlocked ? (
              <AlertDialogAction
                disabled={busy}
                onClick={(event) => {
                  event.preventDefault();
                  void previewImport();
                }}
              >
                {busy ? t('settings.data.previewing') : t('settings.data.previewImport')}
              </AlertDialogAction>
            ) : (
              <AlertDialogAction
                variant="destructive"
                disabled={busy || !dormantConfirmed}
                onClick={(event) => {
                  event.preventDefault();
                  void commitImport();
                }}
              >
                {busy ? t('settings.data.importing') : t('settings.data.overwrite')}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

async function loadMaintenanceStatus(): Promise<DataImportMaintenanceStatus> {
  return sendDataImportRpc<DataImportMaintenanceStatus>({
    type: DATA_IMPORT_RPC_TYPE,
    action: 'status',
  });
}

function summarizeBlockers(preview: DataImportCoordinatorPreview) {
  const sum = (values: Record<string, number | undefined>) =>
    Object.values(values).reduce<number>((total, value) => total + (value ?? 0), 0);
  return {
    active: preview.blockers.activeThreadIds.length,
    hard: sum(preview.blockers.hardRuns),
    dormant: sum(preview.blockers.dormantRuns),
    approvals: preview.blockers.pendingApprovals,
    interactions: preview.blockers.pendingInteractions,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
