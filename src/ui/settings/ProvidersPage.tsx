/**
 * Providers settings (docs/09 §3.4): connection cards → edit form with
 * template picker, multi-key textarea, custom headers, quirks, inline Verify
 * with structured results. Built on shadcn/ui primitives.
 */

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
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
import { createAdapter, normalizeBaseUrl } from '../../providers/registry';
import type { Connection, QuirkFlags, VerifyResult } from '../../providers/types';
import { SettingsStore } from '../../settings/store';
import {
  decryptHeaderValue,
  decryptSecret,
  encryptHeaderValue,
  encryptSecret,
  isEncrypted,
} from '../../settings/crypto';
import { hostPermissionBroker } from '../../permissions/hostPermissionBroker';
import { ModelSelector } from '../components/ModelSelector';

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
  const [defaultModel, setDefaultModel] = useState<{
    connectionId: string;
    modelId: string;
  } | null>(null);

  useEffect(() => {
    void SettingsStore.connections.get().then(setConnections);
    void SettingsStore.global.get().then((g) => setDefaultModel(g.defaultModel ?? null));
  }, []);

  const saveDefaultModel = async (model: { connectionId: string; modelId: string } | null) => {
    setDefaultModel(model);
    const g = await SettingsStore.global.get();
    await SettingsStore.global.set({ ...g, defaultModel: model ?? undefined });
    toast.success(model ? '默认模型已设置' : '默认模型已清除');
  };

  const save = async (list: Connection[]) => {
    setConnections(list);
    await SettingsStore.connections.set(list);
  };

  const upsert = async (conn: Connection) => {
    // Encrypt keys at rest (docs §7); already-encrypted values pass through.
    const encrypted: Connection = {
      ...conn,
      apiKeys: await Promise.all(
        conn.apiKeys.map((k) => (isEncrypted(k) ? Promise.resolve(k) : encryptSecret(k))),
      ),
      customHeaders: conn.customHeaders
        ? Object.fromEntries(
            await Promise.all(
              Object.entries(conn.customHeaders).map(async ([name, value]) => [
                name,
                await encryptHeaderValue(conn.id, name, value),
              ]),
            ),
          )
        : undefined,
    };
    const idx = connections.findIndex((c) => c.id === conn.id);
    const list =
      idx === -1
        ? [...connections, encrypted]
        : connections.map((c) => (c.id === conn.id ? encrypted : c));
    await save(list);
    setEditing(null);
    toast.success('连接已保存');
  };

  if (editing) {
    return (
      <ConnectionForm connection={editing} onSave={upsert} onCancel={() => setEditing(null)} />
    );
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
      {connections.length > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">默认模型</div>
            <div className="text-[11px] text-muted-foreground">
              新会话默认使用的模型（会话内切换过则优先沿用上次选择）
            </div>
          </div>
          <div className="ml-auto">
            <ModelSelector
              value={defaultModel}
              onSelect={(choice) =>
                void saveDefaultModel(
                  choice ? { connectionId: choice.connectionId, modelId: choice.modelId } : null,
                )
              }
            />
          </div>
        </div>
      )}
      {connections.map((c) => (
        <div
          key={c.id}
          className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
        >
          <Switch
            checked={c.enabled}
            onCheckedChange={(on) =>
              void save(connections.map((x) => (x.id === c.id ? { ...x, enabled: on } : x)))
            }
            aria-label={`启用 ${c.name}`}
          />
          <div className="min-w-0">
            <div className="text-[13px] font-medium">{c.name || c.baseUrl}</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {c.kind} · {c.baseUrl} · {c.apiKeys.length} key{c.apiKeys.length === 1 ? '' : 's'}
            </div>
          </div>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(c)}>
              编辑
            </Button>
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
            <AlertDialogDescription>
              该连接的模型将不再可用；已有会话记录不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
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
  const [headersText, setHeadersText] = useState('');
  const [modelConfigText, setModelConfigText] = useState(
    connection.models?.length ? JSON.stringify(connection.models, null, 2) : '',
  );
  const [formError, setFormError] = useState<string | null>(null);

  // Decrypt stored keys for display when editing an existing connection.
  useEffect(() => {
    void Promise.all(
      connection.apiKeys.map((k) => (isEncrypted(k) ? decryptSecret(k) : Promise.resolve(k))),
    ).then((keys) => setKeysText(keys.join('\n')));
  }, [connection.apiKeys, connection.id]);
  useEffect(() => {
    if (!connection.customHeaders) {
      setHeadersText('');
      return;
    }
    void Promise.all(
      Object.entries(connection.customHeaders).map(
        async ([name, value]) =>
          [name, await decryptHeaderValue(connection.id, name, value)] as const,
      ),
    ).then((headers) =>
      setHeadersText(headers.map(([name, value]) => `${name}: ${value}`).join('\n')),
    );
  }, [connection.customHeaders, connection.id]);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [urlHint, setUrlHint] = useState<string | undefined>();

  const built = (): Connection => {
    const { url, hint } = normalizeBaseUrl(conn.baseUrl, conn.kind);
    setUrlHint(hint);
    // Name is optional — default to the endpoint hostname.
    const name =
      conn.name.trim() ||
      (() => {
        try {
          return new URL(url).hostname;
        } catch {
          return url;
        }
      })();
    let models: Connection['models'];
    if (modelConfigText.trim()) {
      const parsed: unknown = JSON.parse(modelConfigText);
      models = parseModelConfigs(parsed);
    }
    const customHeaders = Object.fromEntries(
      headersText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf(':');
          if (separator <= 0) throw new Error(`自定义 Header 格式无效: ${line}`);
          return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
        }),
    );
    return {
      ...conn,
      name,
      baseUrl: url,
      apiKeys: keysText
        .split('\n')
        .map((k) => k.trim())
        .filter(Boolean),
      modelIds: modelsText.trim()
        ? modelsText
            .split('\n')
            .map((m) => m.trim())
            .filter(Boolean)
        : undefined,
      models,
      customHeaders: Object.keys(customHeaders).length > 0 ? customHeaders : undefined,
    };
  };

  const requestHostPermission = async (baseUrl: string): Promise<boolean> => {
    try {
      return await hostPermissionBroker.request(baseUrl);
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
        setVerifyResult({
          reachable: false,
          keyValid: false,
          streaming: false,
          toolUse: false,
          failure: 'needs_host_permission',
        });
        return;
      }
      const result = await createAdapter(candidate).verify();
      setVerifyResult(result);
    } catch (e) {
      setVerifyResult({
        reachable: false,
        keyValid: false,
        streaming: false,
        toolUse: false,
        failure: 'unreachable',
        detail: (e as Error).message,
      });
    } finally {
      setVerifying(false);
    }
  };

  const labelCls = 'mb-1 block text-[12px] text-muted-foreground';

  return (
    <div className="max-w-xl space-y-4">
      <h2 className="text-[15px] font-semibold">
        {connection.name ? `编辑 ${connection.name}` : '添加连接'}
      </h2>

      {/* Classified by interface type, not vendor: pick the wire protocol,
          then enter the endpoint domain + key. */}
      <div>
        <Label className={labelCls}>接口类型</Label>
        <Select
          value={conn.kind}
          onValueChange={(v) => setConn({ ...conn, kind: v as Connection['kind'] })}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="openai">OpenAI 兼容（/chat/completions）</SelectItem>
            <SelectItem value="anthropic">Anthropic（/v1/messages）</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label className={labelCls} htmlFor="conn-name">
          名称（可选，留空自动取域名）
        </Label>
        <Input
          id="conn-name"
          value={conn.name}
          onChange={(e) => setConn({ ...conn, name: e.target.value })}
          placeholder="给这个连接起个名字"
        />
      </div>

      <div>
        <Label className={labelCls} htmlFor="conn-url">
          Base URL
        </Label>
        <Input
          id="conn-url"
          className="font-mono"
          value={conn.baseUrl}
          placeholder="https://api.example.com/v1"
          onChange={(e) => setConn({ ...conn, baseUrl: e.target.value })}
        />
        {urlHint && <div className="mt-1 text-[11px] text-warning">{urlHint}</div>}
      </div>

      <div>
        <Label className={labelCls} htmlFor="conn-keys">
          API Keys（每行一个，多 key 自动 failover）
        </Label>
        <Textarea
          id="conn-keys"
          className="font-mono"
          rows={2}
          value={keysText}
          onChange={(e) => setKeysText(e.target.value)}
          placeholder="sk-…"
        />
      </div>

      <div>
        <Label className={labelCls} htmlFor="conn-models">
          模型列表（自动从端点 /models 获取；仅当端点不支持时手填，每行一个）
        </Label>
        <Textarea
          id="conn-models"
          className="font-mono"
          rows={2}
          value={modelsText}
          onChange={(e) => setModelsText(e.target.value)}
          placeholder={'留空 = 自动获取\ngpt-5'}
        />
      </div>

      <Collapsible>
        <CollapsibleTrigger className="text-[12px] text-muted-foreground hover:text-foreground data-[state=open]:text-foreground">
          兼容性开关（quirks）
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 space-y-2 rounded-md border border-border p-3 text-[13px]">
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
                  onCheckedChange={(on) =>
                    setConn({
                      ...conn,
                      quirks: { ...conn.quirks, [key]: on === true || undefined },
                    })
                  }
                />
                {label}
              </label>
            ))}
            <label className="flex items-center gap-2">
              max_tokens 字段名
              <Select
                value={conn.quirks?.maxTokensField ?? 'max_tokens'}
                onValueChange={(v) =>
                  setConn({
                    ...conn,
                    quirks: { ...conn.quirks, maxTokensField: v as QuirkFlags['maxTokensField'] },
                  })
                }
              >
                <SelectTrigger size="sm" className="font-mono text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="max_tokens">max_tokens</SelectItem>
                  <SelectItem value="max_completion_tokens">max_completion_tokens</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible>
        <CollapsibleTrigger className="text-[12px] text-muted-foreground hover:text-foreground data-[state=open]:text-foreground">
          自定义 Header 与模型能力/价格
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 space-y-3 rounded-md border border-border p-3">
            <div>
              <Label className={labelCls} htmlFor="conn-headers">
                自定义 Header（每行 Name: Value，敏感值本机加密）
              </Label>
              <Textarea
                id="conn-headers"
                className="font-mono text-[12px]"
                rows={3}
                value={headersText}
                onChange={(event) => setHeadersText(event.target.value)}
                placeholder="X-Organization: org-id"
              />
            </div>
            <div>
              <Label className={labelCls} htmlFor="conn-model-config">
                模型能力与价格 JSON（价格单位：$/M tokens）
              </Label>
              <Textarea
                id="conn-model-config"
                className="font-mono text-[11px]"
                rows={7}
                value={modelConfigText}
                onChange={(event) => setModelConfigText(event.target.value)}
                placeholder={
                  '[{\n  "id": "model-id",\n  "capabilities": { "toolUse": true, "vision": true, "reasoning": false, "maxContext": 128000 },\n  "pricing": { "input": 1, "output": 4 }\n}]'
                }
              />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {verifyResult && (
        <Alert
          className={
            verifyResult.keyValid
              ? 'border-success/40 bg-success/5'
              : 'border-destructive/40 bg-destructive/5'
          }
        >
          <AlertDescription className="text-[13px]">
            <div className="flex gap-3">
              <span className={verifyResult.reachable ? 'text-success' : 'text-destructive'}>
                {verifyResult.reachable ? '✓' : '✗'} 可达
              </span>
              <span className={verifyResult.keyValid ? 'text-success' : 'text-destructive'}>
                {verifyResult.keyValid ? '✓' : '✗'} Key 有效
              </span>
              <span className={verifyResult.streaming ? 'text-success' : 'text-muted-foreground'}>
                {verifyResult.streaming ? '✓' : '—'} 流式
              </span>
              <span className={verifyResult.toolUse ? 'text-success' : 'text-muted-foreground'}>
                {verifyResult.toolUse ? '✓' : '—'} 工具调用
              </span>
            </div>
            {verifyResult.failure && (
              <div className="text-destructive">{FAILURE_TEXT[verifyResult.failure]}</div>
            )}
            {verifyResult.models && verifyResult.models.length > 0 && (
              <div className="mt-1.5">
                <div className="text-muted-foreground">
                  从端点发现 {verifyResult.models.length} 个模型：
                </div>
                <div className="mt-1 flex max-h-24 flex-wrap gap-1 overflow-y-auto">
                  {verifyResult.models.map((m) => (
                    <span
                      key={m}
                      className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                    >
                      {m}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </AlertDescription>
        </Alert>
      )}
      {formError && <div className="text-[12px] text-destructive">{formError}</div>}

      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => void verify()} disabled={verifying}>
          {verifying ? '验证中…' : 'Verify 连接测试'}
        </Button>
        <Button
          size="sm"
          className="ml-auto px-4"
          onClick={() => {
            try {
              setFormError(null);
              onSave(built());
            } catch (error) {
              setFormError(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          保存
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}

function parseModelConfigs(value: unknown): NonNullable<Connection['models']> {
  if (!Array.isArray(value)) throw new Error('模型能力/价格必须是 JSON 数组');
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null)
      throw new Error(`模型配置 ${index + 1} 必须是对象`);
    const model = entry as Record<string, unknown>;
    const capabilities = model.capabilities as Record<string, unknown> | undefined;
    if (
      typeof model.id !== 'string' ||
      !model.id ||
      !capabilities ||
      typeof capabilities.toolUse !== 'boolean' ||
      typeof capabilities.vision !== 'boolean'
    ) {
      throw new Error(`模型配置 ${index + 1} 缺少 id/toolUse/vision`);
    }
    const pricing = model.pricing as Record<string, unknown> | undefined;
    if (
      pricing &&
      (typeof pricing.input !== 'number' ||
        pricing.input < 0 ||
        typeof pricing.output !== 'number' ||
        pricing.output < 0 ||
        (pricing.cacheRead !== undefined &&
          (typeof pricing.cacheRead !== 'number' || pricing.cacheRead < 0)))
    ) {
      throw new Error(`模型配置 ${index + 1} 的 pricing 无效`);
    }
    return entry as NonNullable<Connection['models']>[number];
  });
}
