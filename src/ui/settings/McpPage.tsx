/**
 * MCP settings (docs/07 §5, docs/09 §3.4): server cards with state indicators,
 * paste-JSON import, add form, OAuth trigger. The manager lives in the
 * background SW; this page talks to storage + messages the SW for connect.
 * Built on shadcn/ui primitives; delete confirm uses AlertDialog.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { Textarea } from '../components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
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
import { parseMcpJson, type McpServerConfig } from '../../mcp/types';
import { storageGet, storageSet } from '../../settings/store';

const SERVERS_KEY = 'mcp_servers';

export function McpPage() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [importText, setImportText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleting, setDeleting] = useState<McpServerConfig | null>(null);

  const refresh = () => storageGet<McpServerConfig[]>(SERVERS_KEY, []).then(setServers);
  useEffect(() => void refresh(), []);

  const save = async (list: McpServerConfig[]) => {
    setServers(list);
    await storageSet(SERVERS_KEY, list);
  };

  const doImport = async () => {
    try {
      const parsed = parseMcpJson(importText);
      const added: McpServerConfig[] = parsed.map((p) => ({
        ...p,
        id: crypto.randomUUID(),
        enabled: true,
        disabledTools: [],
        connectOnStartup: false,
      }));
      await save([...servers, ...added]);
      setImportText('');
      setImportOpen(false);
      setError(null);
      toast.success(`已添加 ${added.length} 个服务器`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const requestHost = async (url: string) => {
    try {
      await chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] });
    } catch {
      /* non-extension env */
    }
  };

  return (
    <div className="max-w-2xl space-y-3">
      <div className="flex items-center">
        <h2 className="text-[15px] font-semibold">MCP 服务器</h2>
        <Button size="sm" className="ml-auto" onClick={() => setImportOpen((v) => !v)}>
          粘贴 JSON 导入
        </Button>
      </div>

      <Collapsible open={importOpen} onOpenChange={setImportOpen}>
        <CollapsibleTrigger className="sr-only">导入配置</CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 rounded-lg border border-border p-3">
            <Textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={6}
              placeholder={'{\n  "mcpServers": {\n    "github": { "url": "https://…/mcp", "headers": { "Authorization": "Bearer …" } }\n  }\n}'}
              className="font-mono text-[12px]"
            />
            <div className="text-[11px] text-muted-foreground">兼容 Claude Code mcpServers / Cursor 配置片段（识别 url / type / headers.Authorization）。</div>
            {error && <div className="text-[12px] text-destructive">{error}</div>}
            <Button variant="outline" size="sm" onClick={() => void doImport()}>解析并添加</Button>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {servers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-[13px] text-muted-foreground">
          还没有 MCP 服务器。粘贴一份配置片段即可接入远端工具。
        </div>
      ) : (
        servers.map((s) => (
          <div key={s.id} className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
            <Switch
              checked={s.enabled}
              onCheckedChange={(on) => void save(servers.map((x) => (x.id === s.id ? { ...x, enabled: on } : x)))}
              aria-label={`启用 ${s.name}`}
            />
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{s.name}</div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {s.url} · {s.auth.kind}
              </div>
            </div>
            <div className="ml-auto flex gap-2">
              {s.auth.kind === 'oauth' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void requestHost(s.url).then(() => chrome.runtime.sendMessage({ type: 'panelot.mcpOauth', id: s.id }))}
                >
                  授权
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setDeleting(s)}
              >
                删除
              </Button>
            </div>
          </div>
        ))
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 {deleting?.name}？</AlertDialogTitle>
            <AlertDialogDescription>其提供的工具与 Prompt 将不再可用。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deleting) {
                  void save(servers.filter((x) => x.id !== deleting.id));
                  toast.success('服务器已删除');
                }
                setDeleting(null);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
