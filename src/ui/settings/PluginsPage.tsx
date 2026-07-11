import { useEffect, useMemo, useState } from 'react';
import { Archive, ExternalLink, Package, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PanelotDB } from '../../db/schema';
import type { PluginAssetRecord, PluginRecord } from '../../db/types';
import { hostPermissionBroker } from '../../permissions/hostPermissionBroker';
import { PluginManager, pluginDownloadPermissionOrigins } from '../../plugins/manager';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';

const db = new PanelotDB();

export function PluginsPage() {
  const manager = useMemo(() => new PluginManager(db), []);
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [assets, setAssets] = useState<PluginAssetRecord[]>([]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const [nextPlugins, nextAssets] = await Promise.all([
      db.plugins.orderBy('name').toArray(),
      db.pluginAssets.orderBy('createdAt').toArray(),
    ]);
    setPlugins(nextPlugins);
    setAssets(nextAssets);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const installZip = async (file: File) => {
    setBusy(true);
    try {
      await manager.installZip(await file.arrayBuffer(), { kind: 'zip', ref: file.name });
      await refresh();
      toast.success('Plugin 已安装');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const installUrl = async () => {
    setBusy(true);
    try {
      const parsed = new URL(url);
      const granted = await hostPermissionBroker.requestAll(
        pluginDownloadPermissionOrigins(parsed),
      );
      if (!granted) throw new Error('未授予 GitHub 下载权限');
      await manager.installFromUrl(parsed.href);
      setUrl('');
      await refresh();
      toast.success('Plugin 已安装');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h2 className="text-[15px] font-semibold">Plugins</h2>
        <p className="mt-1 text-[11px] text-faint-foreground">
          安装包限制：10 MB 压缩、50 MB 解压、1000 文件；不执行包内代码。
        </p>
      </div>

      <div className="grid gap-2 rounded-xl border border-border/40 p-3 sm:grid-cols-[1fr_auto]">
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://github.com/owner/repo/archive/refs/heads/main.zip"
          aria-label="GitHub Plugin ZIP URL"
        />
        <Button size="sm" disabled={busy || !url.trim()} onClick={() => void installUrl()}>
          <ExternalLink className="mr-1 size-3.5" /> 从 GitHub 安装
        </Button>
        <Button variant="outline" size="sm" asChild disabled={busy}>
          <label className="cursor-pointer sm:col-span-2 sm:w-fit">
            <Archive className="mr-1 inline size-3.5" /> 选择本地 ZIP
            <input
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void installZip(file);
                event.target.value = '';
              }}
            />
          </label>
        </Button>
      </div>

      {plugins.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-[12px] text-faint-foreground">
          尚未安装 Plugin
        </div>
      ) : (
        <div className="space-y-2">
          {plugins.map((plugin) => {
            const owned = assets.filter((asset) => asset.pluginId === plugin.id);
            return (
              <article key={plugin.id} className="rounded-xl border border-border/40 bg-card p-3">
                <div className="flex items-start gap-2">
                  <Package className="mt-0.5 size-4 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-medium">{plugin.name}</span>
                      <span className="text-[11px] text-faint-foreground">
                        {plugin.version} · {plugin.id}
                      </span>
                    </div>
                    {plugin.description && (
                      <p className="mt-1 text-[12px] text-muted-foreground">{plugin.description}</p>
                    )}
                  </div>
                  <Switch
                    checked={plugin.enabled}
                    aria-label={`${plugin.name} ${plugin.enabled ? '停用' : '启用'}`}
                    onCheckedChange={(enabled) =>
                      void manager.setEnabled(plugin.id, enabled).then(refresh)
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-destructive"
                    aria-label={`卸载 ${plugin.name}`}
                    onClick={() => void manager.uninstall(plugin.id).then(refresh)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <details className="mt-2 text-[11px] text-muted-foreground">
                  <summary className="cursor-pointer">安装清单（{owned.length}）</summary>
                  <ul className="mt-1 space-y-0.5 pl-4 font-mono">
                    {owned.map((asset) => (
                      <li key={asset.id}>
                        {asset.kind}: {asset.path}
                      </li>
                    ))}
                  </ul>
                </details>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
