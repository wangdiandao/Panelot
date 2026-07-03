/**
 * Data settings (DESIGN §12): full JSON export/import (keys stripped by
 * default), storage usage display, quota warning.
 */

import { useEffect, useState } from 'react';
import { PanelotDB } from '../../db/schema';
import { exportAll, importBundle, type ExportBundle } from '../../data/exportImport';
import { getQuotaStatus, type QuotaStatus } from '../../data/quota';

const db = new PanelotDB();

export function DataPage() {
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [includeKeys, setIncludeKeys] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void getQuotaStatus().then(setQuota);
  }, []);

  const doExport = async () => {
    const bundle = await exportAll(db, { includeKeys });
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `panelot-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doImport = async (file: File) => {
    try {
      const bundle = JSON.parse(await file.text()) as ExportBundle;
      if (!confirm('导入将覆盖现有会话与设置。继续？')) return;
      await importBundle(db, bundle, { merge: false });
      setStatus('导入成功，请重新打开侧边栏。');
    } catch (e) {
      setStatus(`导入失败: ${(e as Error).message}`);
    }
  };

  return (
    <div className="max-w-xl space-y-5">
      <h2 className="text-[15px] font-semibold">数据</h2>

      {quota && (
        <div className="space-y-1">
          <div className="flex justify-between text-[12px] text-muted-foreground">
            <span>存储用量</span>
            <span>
              {(quota.usage / 1024 / 1024).toFixed(1)} MB / {(quota.quota / 1024 / 1024).toFixed(0)} MB（{Math.round(quota.pct * 100)}%）
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className={`h-full ${quota.warn ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${Math.round(quota.pct * 100)}%` }} />
          </div>
          {quota.warn && <div className="text-[11px] text-destructive">存储接近上限，建议导出后清理旧会话。</div>}
        </div>
      )}

      <div className="space-y-2">
        <div className="text-[13px] font-medium">导出</div>
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <input type="checkbox" checked={includeKeys} onChange={(e) => setIncludeKeys(e.target.checked)} />
          包含 API Key（默认剔除，谨慎开启）
        </label>
        <button type="button" onClick={() => void doExport()} className="rounded-md bg-primary px-4 py-1.5 text-[12.5px] font-medium text-black hover:brightness-110">
          导出全部为 JSON
        </button>
      </div>

      <div className="space-y-2">
        <div className="text-[13px] font-medium">导入</div>
        <label className="inline-block cursor-pointer rounded-md border border-border px-4 py-1.5 text-[12.5px] hover:bg-muted">
          选择 JSON 文件
          <input type="file" accept=".json" className="hidden" onChange={(e) => e.target.files?.[0] && void doImport(e.target.files[0])} />
        </label>
        {status && <div className="text-[12px] text-muted-foreground">{status}</div>}
      </div>
    </div>
  );
}
