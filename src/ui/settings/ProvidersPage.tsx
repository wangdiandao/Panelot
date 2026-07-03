/**
 * Providers settings (docs/09 §3.4): connection cards → edit form with
 * template picker, multi-key textarea, custom headers, quirks, inline Verify
 * with structured results.
 */

import { useEffect, useState } from 'react';
import { CONNECTION_TEMPLATES, createAdapter, normalizeBaseUrl } from '../../providers/registry';
import type { Connection, QuirkFlags, VerifyResult } from '../../providers/types';
import { SettingsStore } from '../../settings/store';
import { decryptSecret, encryptSecret, isEncrypted } from '../../settings/crypto';

const FAILURE_TEXT: Record<NonNullable<VerifyResult['failure']>, string> = {
  invalid_key: 'API Key 无效 — 检查 Key 是否正确、是否有余额',
  unreachable: '域名不可达 — 检查网络、baseUrl 拼写，或该端点是否需要代理',
  needs_host_permission: '需要授权访问该域名 — 点击 Verify 时允许权限申请',
  protocol_mismatch: '协议不符 — 确认该端点兼容所选 API 风格（OpenAI/Anthropic）',
};

export function ProvidersPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [editing, setEditing] = useState<Connection | null>(null);

  useEffect(() => {
    void SettingsStore.connections.get().then(setConnections);
  }, []);

  const save = async (list: Connection[]) => {
    setConnections(list);
    await SettingsStore.connections.set(list);
  };

  const upsert = async (conn: Connection) => {
    // Encrypt keys at rest (docs §7); already-encrypted values pass through.
    const encrypted: Connection = {
      ...conn,
      apiKeys: await Promise.all(conn.apiKeys.map((k) => (isEncrypted(k) ? Promise.resolve(k) : encryptSecret(k)))),
    };
    const idx = connections.findIndex((c) => c.id === conn.id);
    const list = idx === -1 ? [...connections, encrypted] : connections.map((c) => (c.id === conn.id ? encrypted : c));
    await save(list);
    setEditing(null);
  };

  if (editing) {
    return <ConnectionForm connection={editing} onSave={upsert} onCancel={() => setEditing(null)} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center">
        <h2 className="text-[15px] font-semibold">Providers</h2>
        <button
          type="button"
          onClick={() =>
            setEditing({
              id: crypto.randomUUID(),
              name: '',
              kind: 'openai',
              baseUrl: '',
              apiKeys: [],
              enabled: true,
            })
          }
          className="ml-auto rounded-md bg-accent px-3 py-1 text-[12.5px] font-medium text-black hover:brightness-110"
        >
          ✚ 添加连接
        </button>
      </div>
      {connections.length === 0 && (
        <div className="rounded-[10px] border border-dashed border-border p-6 text-center text-[13px] text-text-dim">
          还没有配置任何模型连接。点击「添加连接」，选择预置模板，填入 API Key 即可开聊。
        </div>
      )}
      {connections.map((c) => (
        <div key={c.id} className="flex items-center gap-3 rounded-[10px] border border-border bg-surface px-4 py-3">
          <span className={`h-2 w-2 rounded-full ${c.enabled ? 'bg-ok' : 'bg-text-dim'}`} />
          <div className="min-w-0">
            <div className="text-[13px] font-medium">{c.name || c.baseUrl}</div>
            <div className="truncate font-mono text-[11px] text-text-dim">
              {c.kind} · {c.baseUrl} · {c.apiKeys.length} key{c.apiKeys.length === 1 ? '' : 's'}
            </div>
          </div>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => void save(connections.map((x) => (x.id === c.id ? { ...x, enabled: !x.enabled } : x)))}
              className="rounded-md border border-border px-2 py-1 text-[11px] text-text-dim hover:bg-surface-2"
            >
              {c.enabled ? '停用' : '启用'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(c)}
              className="rounded-md border border-border px-2 py-1 text-[11px] hover:bg-surface-2"
            >
              编辑
            </button>
            <button
              type="button"
              onClick={() => {
                if (confirm(`删除连接「${c.name}」？`)) void save(connections.filter((x) => x.id !== c.id));
              }}
              className="rounded-md border border-danger/40 px-2 py-1 text-[11px] text-danger hover:bg-danger/10"
            >
              删除
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ConnectionForm({
  connection,
  onSave,
  onCancel,
}: {
  connection: Connection;
  onSave: (c: Connection) => void;
  onCancel: () => void;
}) {
  const [conn, setConn] = useState(connection);
  const [keysText, setKeysText] = useState('');
  const [modelsText, setModelsText] = useState(connection.modelIds?.join('\n') ?? '');

  // Decrypt stored keys for display when editing an existing connection.
  useEffect(() => {
    void Promise.all(connection.apiKeys.map((k) => (isEncrypted(k) ? decryptSecret(k) : Promise.resolve(k)))).then((keys) =>
      setKeysText(keys.join('\n')),
    );
  }, [connection.id]);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [urlHint, setUrlHint] = useState<string | undefined>();
  const [showQuirks, setShowQuirks] = useState(false);

  const applyTemplate = (name: string) => {
    const tpl = CONNECTION_TEMPLATES.find((t) => t.name === name);
    if (!tpl) return;
    setConn((c) => ({ ...c, name: tpl.name === 'Custom' ? '' : tpl.name, kind: tpl.kind, baseUrl: tpl.baseUrl, quirks: tpl.quirks }));
  };

  const built = (): Connection => {
    const { url, hint } = normalizeBaseUrl(conn.baseUrl, conn.kind);
    setUrlHint(hint);
    return {
      ...conn,
      baseUrl: url,
      apiKeys: keysText.split('\n').map((k) => k.trim()).filter(Boolean),
      modelIds: modelsText.trim() ? modelsText.split('\n').map((m) => m.trim()).filter(Boolean) : undefined,
    };
  };

  const requestHostPermission = async (baseUrl: string): Promise<boolean> => {
    try {
      const origin = new URL(baseUrl).origin;
      return await chrome.permissions.request({ origins: [`${origin}/*`] });
    } catch {
      return true; // non-extension test envs
    }
  };

  const verify = async () => {
    const candidate = built();
    setVerifying(true);
    setVerifyResult(null);
    try {
      const granted = await requestHostPermission(candidate.baseUrl);
      if (!granted) {
        setVerifyResult({ reachable: false, keyValid: false, streaming: false, toolUse: false, failure: 'needs_host_permission' });
        return;
      }
      const result = await createAdapter(candidate).verify();
      setVerifyResult(result);
    } catch (e) {
      setVerifyResult({
        reachable: false, keyValid: false, streaming: false, toolUse: false,
        failure: 'unreachable', detail: (e as Error).message,
      });
    } finally {
      setVerifying(false);
    }
  };

  const input = 'w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 text-[13px] outline-none focus:border-accent/60';
  const labelCls = 'mb-1 block text-[12px] text-text-dim';

  return (
    <div className="max-w-xl space-y-4">
      <h2 className="text-[15px] font-semibold">{connection.name ? `编辑 ${connection.name}` : '添加连接'}</h2>

      <div>
        <label className={labelCls}>预置模板</label>
        <div className="flex flex-wrap gap-1">
          {CONNECTION_TEMPLATES.map((t) => (
            <button
              key={t.name}
              type="button"
              onClick={() => applyTemplate(t.name)}
              className={`rounded-full border px-2 py-0.5 text-[11px] ${conn.name === t.name ? 'border-accent text-accent' : 'border-border text-text-dim hover:border-accent/60'}`}
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>名称</label>
          <input className={input} value={conn.name} onChange={(e) => setConn({ ...conn, name: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>协议</label>
          <select className={input} value={conn.kind} onChange={(e) => setConn({ ...conn, kind: e.target.value as Connection['kind'] })}>
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>
      </div>

      <div>
        <label className={labelCls}>Base URL</label>
        <input className={`${input} font-mono`} value={conn.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setConn({ ...conn, baseUrl: e.target.value })} />
        {urlHint && <div className="mt-1 text-[11px] text-warn">{urlHint}</div>}
      </div>

      <div>
        <label className={labelCls}>API Keys（每行一个，多 key 自动 failover）</label>
        <textarea className={`${input} font-mono`} rows={2} value={keysText} onChange={(e) => setKeysText(e.target.value)} placeholder="sk-…" />
      </div>

      <div>
        <label className={labelCls}>手动模型列表（可选，每行一个；端点无 /models 时使用）</label>
        <textarea className={`${input} font-mono`} rows={2} value={modelsText} onChange={(e) => setModelsText(e.target.value)} placeholder="gpt-5&#10;claude-sonnet-5" />
      </div>

      <div>
        <button type="button" onClick={() => setShowQuirks((v) => !v)} className="text-[12px] text-text-dim hover:text-text" aria-expanded={showQuirks}>
          {showQuirks ? '▾' : '▸'} 兼容性开关（quirks）
        </button>
        {showQuirks && (
          <div className="mt-2 space-y-1 rounded-md border border-border p-3 text-[12.5px]">
            {(
              [
                ['noStreamOptions', '端点不支持 stream_options.include_usage'],
                ['thinkTagReasoning', '推理内容走 <think> 内联标签（DeepSeek 等）'],
                ['noParallelToolCalls', '强制单工具调用'],
                ['noSystemRole', '不支持 system 角色（转为首条 user）'],
              ] as [keyof QuirkFlags, string][]
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={Boolean(conn.quirks?.[key])}
                  onChange={(e) => setConn({ ...conn, quirks: { ...conn.quirks, [key]: e.target.checked || undefined } })}
                />
                {label}
              </label>
            ))}
            <label className="flex items-center gap-2">
              max_tokens 字段名
              <select
                className="rounded border border-border bg-surface-2 px-1 py-0.5 text-[12px]"
                value={conn.quirks?.maxTokensField ?? 'max_tokens'}
                onChange={(e) => setConn({ ...conn, quirks: { ...conn.quirks, maxTokensField: e.target.value as QuirkFlags['maxTokensField'] } })}
              >
                <option value="max_tokens">max_tokens</option>
                <option value="max_completion_tokens">max_completion_tokens</option>
              </select>
            </label>
          </div>
        )}
      </div>

      {verifyResult && (
        <div className={`rounded-md border p-3 text-[12.5px] ${verifyResult.keyValid ? 'border-ok/40 bg-ok/5' : 'border-danger/40 bg-danger/5'}`}>
          <div className="mb-1 flex gap-3">
            <span className={verifyResult.reachable ? 'text-ok' : 'text-danger'}>{verifyResult.reachable ? '✓' : '✗'} 可达</span>
            <span className={verifyResult.keyValid ? 'text-ok' : 'text-danger'}>{verifyResult.keyValid ? '✓' : '✗'} Key 有效</span>
            <span className={verifyResult.streaming ? 'text-ok' : 'text-text-dim'}>{verifyResult.streaming ? '✓' : '—'} 流式</span>
            <span className={verifyResult.toolUse ? 'text-ok' : 'text-text-dim'}>{verifyResult.toolUse ? '✓' : '—'} 工具调用</span>
          </div>
          {verifyResult.failure && <div className="text-danger">{FAILURE_TEXT[verifyResult.failure]}</div>}
          {verifyResult.models && <div className="text-text-dim">发现 {verifyResult.models.length} 个模型</div>}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void verify()}
          disabled={verifying}
          className="rounded-md border border-border px-3 py-1.5 text-[12.5px] hover:bg-surface-2 disabled:opacity-50"
        >
          {verifying ? '验证中…' : 'Verify 连接测试'}
        </button>
        <button
          type="button"
          onClick={() => onSave(built())}
          className="ml-auto rounded-md bg-accent px-4 py-1.5 text-[12.5px] font-medium text-black hover:brightness-110"
        >
          保存
        </button>
        <button type="button" onClick={onCancel} className="rounded-md border border-border px-3 py-1.5 text-[12.5px] hover:bg-surface-2">
          取消
        </button>
      </div>
    </div>
  );
}
