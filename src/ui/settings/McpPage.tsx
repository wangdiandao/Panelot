/**
 * MCP settings (docs/07 §5, docs/09 §3.4): server cards with state indicators,
 * paste-JSON import, add form, OAuth trigger. The manager lives in the
 * background SW; this page talks to storage + messages the SW for connect.
 */

import { useEffect, useState } from 'react';
import { parseMcpJson, type McpServerConfig } from '../../mcp/types';
import { storageGet, storageSet } from '../../settings/store';

const SERVERS_KEY = 'mcp_servers';

export function McpPage() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [importText, setImportText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);

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
      setShowImport(false);
      setError(null);
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
        <button
          type="button"
          onClick={() => setShowImport((v) => !v)}
          className="ml-auto rounded-md bg-primary px-3 py-1 text-[12.5px] font-medium text-black hover:brightness-110"
        >
          粘贴 JSON 导入
        </button>
      </div>

      {showImport && (
        <div className="space-y-2 rounded-[10px] border border-border p-3">
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={6}
            placeholder={'{\n  "mcpServers": {\n    "github": { "url": "https://…/mcp", "headers": { "Authorization": "Bearer …" } }\n  }\n}'}
            className="w-full rounded-md border border-border bg-muted p-2 font-mono text-[12px] outline-none focus:border-primary/60"
          />
          <div className="text-[11px] text-muted-foreground">兼容 Claude Code mcpServers / Cursor 配置片段（识别 url / type / headers.Authorization）。</div>
          {error && <div className="text-[12px] text-destructive">{error}</div>}
          <button type="button" onClick={() => void doImport()} className="rounded-md border border-border px-3 py-1 text-[12px] hover:bg-muted">解析并添加</button>
        </div>
      )}

      {servers.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-border p-6 text-center text-[13px] text-muted-foreground">
          还没有 MCP 服务器。粘贴一份配置片段即可接入远端工具。
        </div>
      ) : (
        servers.map((s) => (
          <div key={s.id} className="flex items-center gap-3 rounded-[10px] border border-border bg-card px-4 py-3">
            <span className={`h-2 w-2 rounded-full ${s.enabled ? 'bg-success' : 'bg-muted-foreground'}`} />
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{s.name}</div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {s.url} · {s.auth.kind}
              </div>
            </div>
            <div className="ml-auto flex gap-2">
              {s.auth.kind === 'oauth' && (
                <button
                  type="button"
                  onClick={() => void requestHost(s.url).then(() => chrome.runtime.sendMessage({ type: 'panelot.mcpOauth', id: s.id }))}
                  className="rounded-md border border-border px-2 py-1 text-[11px] hover:bg-muted"
                >
                  授权
                </button>
              )}
              <button
                type="button"
                onClick={() => void save(servers.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)))}
                className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
              >
                {s.enabled ? '停用' : '启用'}
              </button>
              <button
                type="button"
                onClick={() => { if (confirm(`删除 ${s.name}？`)) void save(servers.filter((x) => x.id !== s.id)); }}
                className="rounded-md border border-destructive/40 px-2 py-1 text-[11px] text-destructive hover:bg-destructive/10"
              >
                删除
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
