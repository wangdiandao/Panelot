/**
 * Providers settings (docs/09 §3.4): connection cards → edit form with
 * template picker, multi-key textarea, custom headers, quirks, inline Verify
 * with structured results. Built on shadcn/ui primitives.
 */

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Label } from '../components/ui/label';
import { Switch } from '../components/ui/switch';
import { Checkbox } from '../components/ui/checkbox';
import { Alert, AlertDescription } from '../components/ui/alert';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
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
  const [deleting, setDeleting] = useState<Connection | null>(null);

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
    toast.success('连接已保存');
  };

  if (editing) {
    return <ConnectionForm connection={editing} onSave={upsert} onCancel={() => setEditing(null)} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center">
        <h2 className="text-[15px] font-semibold">Providers</h2>
        <Button
          size="sm"
          className="ml-auto"
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
        >
          <Plus /> 添加连接
        </Button>
      </div>
      {connections.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-[13px] text-muted-foreground">
          还没有配置任何模型连接。点击「添加连接」，选择预置模板，填入 API Key 即可开聊。
        </div>
      )}
      {connections.map((c) => (
        <div key={c.id} className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
          <Switch
            checked={c.enabled}
            onCheckedChange={(on) => void save(connections.map((x) => (x.id === c.id ? { ...x, enabled: on } : x)))}
            aria-label={`启用 ${c.name}`}
          />
          <div className="min-w-0">
            <div className="text-[13px] font-medium">{c.name || c.baseUrl}</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {c.kind} · {c.baseUrl} · {c.apiKeys.length} key{c.apiKeys.length === 1 ? '' : 's'}
            </div>
          </div>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(c)}>编辑</Button>
            <Button
              variant="outline"
              size="sm"
              className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setDeleting(c)}
            >
              删除
            </Button>
          </div>
        </div>
      ))}

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除连接「{deleting?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>该连接的模型将不再可用；已有会话记录不受影响。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deleting) {
                  void save(connections.filter((x) => x.id !== deleting.id));
                  toast.success('连接已删除');
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

  const labelCls = 'mb-1 block text-[12px] text-muted-foreground';

  return (
    <div className="max-w-xl space-y-4">
      <h2 className="text-[15px] font-semibold">{connection.name ? `编辑 ${connection.name}` : '添加连接'}</h2>

      {/* Classified by interface type, not vendor: pick the wire protocol
          first, then an optional endpoint preset within it. */}
      <div>
        <Label className={labelCls}>接口类型</Label>
        <Select value={conn.kind} onValueChange={(v) => setConn({ ...conn, kind: v as Connection['kind'] })}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="openai">OpenAI 兼容（/chat/completions）</SelectItem>
            <SelectItem value="anthropic">Anthropic（/v1/messages）</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label className={labelCls}>常用端点（可选，点选自动填 Base URL）</Label>
        <div className="flex flex-wrap gap-1">
          {CONNECTION_TEMPLATES.filter((t) => t.kind === conn.kind && t.name !== 'Custom').map((t) => (
            <Badge
              key={t.name}
              asChild
              variant={conn.name === t.name ? 'default' : 'outline'}
              className={conn.name === t.name ? '' : 'text-muted-foreground hover:border-primary/60'}
            >
              <button type="button" onClick={() => applyTemplate(t.name)}>{t.name}</button>
            </Badge>
          ))}
        </div>
      </div>

      <div>
        <Label className={labelCls} htmlFor="conn-name">名称</Label>
        <Input id="conn-name" value={conn.name} onChange={(e) => setConn({ ...conn, name: e.target.value })} placeholder="给这个连接起个名字" />
      </div>

      <div>
        <Label className={labelCls} htmlFor="conn-url">Base URL</Label>
        <Input id="conn-url" className="font-mono" value={conn.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setConn({ ...conn, baseUrl: e.target.value })} />
        {urlHint && <div className="mt-1 text-[11px] text-warning">{urlHint}</div>}
      </div>

      <div>
        <Label className={labelCls} htmlFor="conn-keys">API Keys（每行一个，多 key 自动 failover）</Label>
        <Textarea id="conn-keys" className="font-mono" rows={2} value={keysText} onChange={(e) => setKeysText(e.target.value)} placeholder="sk-…" />
      </div>

      <div>
        <Label className={labelCls} htmlFor="conn-models">手动模型列表（可选，每行一个；端点无 /models 时使用）</Label>
        <Textarea id="conn-models" className="font-mono" rows={2} value={modelsText} onChange={(e) => setModelsText(e.target.value)} placeholder={'gpt-5\nclaude-sonnet-5'} />
      </div>

      <Collapsible>
        <CollapsibleTrigger className="text-[12px] text-muted-foreground hover:text-foreground data-[state=open]:text-foreground">
          兼容性开关（quirks）
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 space-y-2 rounded-md border border-border p-3 text-[12.5px]">
            {(
              [
                ['noStreamOptions', '端点不支持 stream_options.include_usage'],
                ['thinkTagReasoning', '推理内容走 <think> 内联标签（DeepSeek 等）'],
                ['noParallelToolCalls', '强制单工具调用'],
                ['noSystemRole', '不支持 system 角色（转为首条 user）'],
              ] as [keyof QuirkFlags, string][]
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2">
                <Checkbox
                  checked={Boolean(conn.quirks?.[key])}
                  onCheckedChange={(on) => setConn({ ...conn, quirks: { ...conn.quirks, [key]: on === true || undefined } })}
                />
                {label}
              </label>
            ))}
            <label className="flex items-center gap-2">
              max_tokens 字段名
              <Select
                value={conn.quirks?.maxTokensField ?? 'max_tokens'}
                onValueChange={(v) => setConn({ ...conn, quirks: { ...conn.quirks, maxTokensField: v as QuirkFlags['maxTokensField'] } })}
              >
                <SelectTrigger size="sm" className="font-mono text-[12px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="max_tokens">max_tokens</SelectItem>
                  <SelectItem value="max_completion_tokens">max_completion_tokens</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {verifyResult && (
        <Alert className={verifyResult.keyValid ? 'border-success/40 bg-success/5' : 'border-destructive/40 bg-destructive/5'}>
          <AlertDescription className="text-[12.5px]">
            <div className="flex gap-3">
              <span className={verifyResult.reachable ? 'text-success' : 'text-destructive'}>{verifyResult.reachable ? '✓' : '✗'} 可达</span>
              <span className={verifyResult.keyValid ? 'text-success' : 'text-destructive'}>{verifyResult.keyValid ? '✓' : '✗'} Key 有效</span>
              <span className={verifyResult.streaming ? 'text-success' : 'text-muted-foreground'}>{verifyResult.streaming ? '✓' : '—'} 流式</span>
              <span className={verifyResult.toolUse ? 'text-success' : 'text-muted-foreground'}>{verifyResult.toolUse ? '✓' : '—'} 工具调用</span>
            </div>
            {verifyResult.failure && <div className="text-destructive">{FAILURE_TEXT[verifyResult.failure]}</div>}
            {verifyResult.models && <div className="text-muted-foreground">发现 {verifyResult.models.length} 个模型</div>}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => void verify()} disabled={verifying}>
          {verifying ? '验证中…' : 'Verify 连接测试'}
        </Button>
        <Button size="sm" className="ml-auto px-4" onClick={() => onSave(built())}>保存</Button>
        <Button variant="outline" size="sm" onClick={onCancel}>取消</Button>
      </div>
    </div>
  );
}
