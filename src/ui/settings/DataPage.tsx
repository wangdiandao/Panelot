/**
 * Data settings (DESIGN §12): full JSON export/import (keys stripped by
 * default), storage usage display, quota warning. Built on shadcn/ui
 * primitives; import confirm uses AlertDialog instead of window.confirm.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
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
import { exportAll, importBundle, type ExportBundle } from '../../data/exportImport';
import { getQuotaStatus, type QuotaStatus } from '../../data/quota';

const db = new PanelotDB();

export function DataPage() {
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [includeKeys, setIncludeKeys] = useState(false);
  const [pendingImport, setPendingImport] = useState<ExportBundle | null>(null);

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
    toast.success('已导出');
  };

  const stageImport = async (file: File) => {
    try {
      setPendingImport(JSON.parse(await file.text()) as ExportBundle);
    } catch (e) {
      toast.error(`导入失败: ${(e as Error).message}`);
    }
  };

  const confirmImport = async () => {
    if (!pendingImport) return;
    try {
      await importBundle(db, pendingImport, { merge: false });
      toast.success('导入成功，请重新打开侧边栏。');
    } catch (e) {
      toast.error(`导入失败: ${(e as Error).message}`);
    } finally {
      setPendingImport(null);
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
          <Checkbox checked={includeKeys} onCheckedChange={(on) => setIncludeKeys(on === true)} />
          包含 API Key（默认剔除，谨慎开启）
        </label>
        <Button size="sm" className="px-4" onClick={() => void doExport()}>
          导出全部为 JSON
        </Button>
      </div>

      <div className="space-y-2">
        <div className="text-[13px] font-medium">导入</div>
        <Button variant="outline" size="sm" asChild>
          <label className="cursor-pointer">
            选择 JSON 文件
            <input
              type="file"
              accept=".json"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.[0]) void stageImport(e.target.files[0]);
                e.target.value = '';
              }}
            />
          </label>
        </Button>
      </div>

      <AlertDialog open={pendingImport !== null} onOpenChange={(o) => !o && setPendingImport(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>导入将覆盖现有数据</AlertDialogTitle>
            <AlertDialogDescription>现有会话与设置会被导入内容替换。建议先导出备份。继续？</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void confirmImport()}
            >
              覆盖导入
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
