/**
 * Data settings (docs/development.md §5; docs/09-ui.md §3.4): full JSON export/import (keys stripped by
 * default), storage usage display, quota warning. Built on shadcn/ui primitives.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
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
import { cn } from '../lib/utils';
import { t } from '../i18n';

const db = new PanelotDB();

type PreparedImport = Awaited<ReturnType<typeof prepareCanonicalImport>>;

export function DataPage() {
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [includeKeys, setIncludeKeys] = useState(false);
  const [backupPassphrase, setBackupPassphrase] = useState('');
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
        <div
          role="status"
          aria-live="polite"
          className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-[12px]"
        >
          <div className="font-medium">{t('settings.data.reloadRequired')}</div>
          <div className="text-muted-foreground">{t('settings.data.reloadRequiredHint')}</div>
          <Button size="sm" variant="destructive" onClick={() => chrome.runtime.reload()}>
            {t('settings.data.reloadNow')}
          </Button>
        </div>
      )}
      {!maintenance?.blocked && maintenance?.reconciliation === 'rolled_back' && (
        <div role="status" className="rounded-lg border p-3 text-[12px] text-muted-foreground">
          {t('settings.data.rollbackRecovered')}
        </div>
      )}
      {!maintenance?.blocked && maintenance?.reconciliation === 'rolled_forward' && (
        <div role="status" className="rounded-lg border p-3 text-[12px] text-muted-foreground">
          {t('settings.data.commitRecovered')}
        </div>
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
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full', quota.warn ? 'bg-destructive' : 'bg-primary')}
              style={{ width: `${Math.round(quota.pct * 100)}%` }}
            />
          </div>
          {quota.warn && (
            <div className="text-[11px] text-destructive">{t('settings.data.nearLimit')}</div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="text-[13px] font-medium">{t('settings.data.export')}</div>
        <Label htmlFor="include-secret-keys" className="flex items-center gap-2">
          <Checkbox
            id="include-secret-keys"
            checked={includeKeys}
            onCheckedChange={(on) => setIncludeKeys(on === true)}
          />
          {t('settings.data.includeSecrets')}
        </Label>
        {includeKeys && (
          <Input
            type="password"
            value={backupPassphrase}
            onChange={(event) => setBackupPassphrase(event.target.value)}
            placeholder={t('settings.data.passphrase')}
            aria-label={t('settings.data.passphrase')}
            autoComplete="new-password"
          />
        )}
        <Button size="sm" className="px-4" onClick={() => void doExport()}>
          {t('settings.data.exportAll')}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-[13px] font-medium">{t('settings.data.import')}</div>
        <FilePickerButton
          id="data-json-import"
          label={t('settings.data.chooseJsonLabel')}
          accept=".json"
          onFile={(file) => void stageImport(file)}
        >
          {t('settings.data.chooseJson')}
        </FilePickerButton>
      </div>

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
            <Input
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
          )}
          {blockerCounts && (
            <div
              role="status"
              aria-live="polite"
              className="flex flex-col gap-2 rounded-md border p-3 text-[12px]"
            >
              <div className="font-medium">
                {preview?.blockers.hardBlocked
                  ? t('settings.data.previewBlocked')
                  : t('settings.data.previewReady')}
              </div>
              <div className="text-muted-foreground">
                {t('settings.data.blockerSummary', blockerCounts)}
              </div>
              {preview?.blockers.requiresDormantConfirmation && !preview.blockers.hardBlocked && (
                <Label htmlFor="confirm-dormant-import" className="items-start gap-2 leading-5">
                  <Checkbox
                    id="confirm-dormant-import"
                    checked={confirmDormant}
                    onCheckedChange={(checked) => setConfirmDormant(checked === true)}
                  />
                  {t('settings.data.confirmDormant')}
                </Label>
              )}
            </div>
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
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
