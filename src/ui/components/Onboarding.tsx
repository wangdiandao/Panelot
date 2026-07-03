/**
 * Onboarding (docs/09 §3.3, OB-1 "first answer ≤2min"): three-step flow shown
 * in the empty conversation when no provider is configured.
 *   ① pick a template + paste a key, inline Verify (turns green on success)
 *   ② choose the approval tier (two-axis semantic cards)
 *   ③ demo prompt card ("try: @当前页面 总结一下")
 * Skippable — a "稍后配置" link falls back to the settings modal.
 */

import { useState } from 'react';
import { Check, ChevronRight, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Badge } from './ui/badge';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import { CONNECTION_TEMPLATES, createAdapter, normalizeBaseUrl } from '../../providers/registry';
import type { Connection, VerifyResult } from '../../providers/types';
import { SettingsStore, type GlobalSettings } from '../../settings/store';
import { encryptSecret } from '../../settings/crypto';

const APPROVAL_TIERS: { id: string; policy: string; scope: string; title: string; desc: string }[] = [
  {
    id: 'safe',
    policy: 'untrusted',
    scope: 'cross-origin',
    title: '稳妥（推荐）',
    desc: '只读操作自动放行；任何写操作与新站点都先问我',
  },
  {
    id: 'smooth',
    policy: 'on-request',
    scope: 'cross-origin',
    title: '顺畅',
    desc: '写操作首次确认后，本轮同站不再重复问',
  },
  {
    id: 'readonly',
    policy: 'untrusted',
    scope: 'read-only',
    title: '仅浏览',
    desc: '只允许读取页面，禁止一切写操作',
  },
];

interface Props {
  onConfigured: () => void;
  onOpenSettings: () => void;
  onTryDemo: (text: string) => void;
}

export function Onboarding({ onConfigured, onOpenSettings, onTryDemo }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [templateName, setTemplateName] = useState<string>(CONNECTION_TEMPLATES[0]?.name ?? '');
  const [apiKey, setApiKey] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState<VerifyResult | null>(null);
  const [tier, setTier] = useState('safe');

  const template = CONNECTION_TEMPLATES.find((t) => t.name === templateName);

  const buildConnection = (): Connection | null => {
    if (!template) return null;
    const { url } = normalizeBaseUrl(template.baseUrl, template.kind);
    return {
      id: crypto.randomUUID(),
      name: template.name,
      kind: template.kind,
      baseUrl: url,
      apiKeys: [apiKey.trim()],
      enabled: true,
      quirks: template.quirks,
    };
  };

  const verify = async () => {
    const conn = buildConnection();
    if (!conn || !apiKey.trim()) return;
    setVerifying(true);
    setVerified(null);
    try {
      try {
        await chrome.permissions.request({ origins: [`${new URL(conn.baseUrl).origin}/*`] });
      } catch { /* non-extension env */ }
      setVerified(await createAdapter(conn).verify());
    } catch (e) {
      setVerified({ reachable: false, keyValid: false, streaming: false, toolUse: false, detail: (e as Error).message });
    } finally {
      setVerifying(false);
    }
  };

  const saveAndNext = async () => {
    const conn = buildConnection();
    if (!conn) return;
    const existing = await SettingsStore.connections.get();
    await SettingsStore.connections.set([
      ...existing,
      { ...conn, apiKeys: await Promise.all(conn.apiKeys.map(encryptSecret)) },
    ]);
    setStep(2);
  };

  const saveTier = async () => {
    const t = APPROVAL_TIERS.find((x) => x.id === tier)!;
    const settings: GlobalSettings = await SettingsStore.global.get();
    await SettingsStore.global.set({ ...settings, defaultApprovalPolicy: t.policy, defaultCapabilityScope: t.scope });
    setStep(3);
    onConfigured();
  };

  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-4 px-4 py-6">
      <div className="flex items-center gap-2 text-[12px] text-faint-foreground">
        {[1, 2, 3].map((n) => (
          <span key={n} className={`flex size-5 items-center justify-center rounded-full text-[11px] ${step >= n ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
            {step > n ? <Check className="size-3" /> : n}
          </span>
        ))}
      </div>

      {step === 1 && (
        <div className="w-full space-y-3 rounded-2xl border border-border bg-card p-5">
          <div className="text-[15px] font-semibold">① 连接你的模型</div>
          <div className="flex flex-wrap gap-1">
            {CONNECTION_TEMPLATES.filter((t) => t.name !== 'Custom').map((t) => (
              <Badge key={t.name} asChild variant={templateName === t.name ? 'default' : 'outline'} className="cursor-pointer">
                <button type="button" onClick={() => { setTemplateName(t.name); setVerified(null); }}>{t.name}</button>
              </Badge>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ob-key" className="text-[12px] text-muted-foreground">API Key</Label>
            <Input
              id="ob-key"
              type="password"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setVerified(null); }}
              placeholder="sk-…"
              className="font-mono"
            />
          </div>
          {verified && (
            <div className={`text-[12px] ${verified.keyValid ? 'text-success' : 'text-destructive'}`}>
              {verified.keyValid ? '✓ 连接成功，Key 有效' : `✗ ${verified.detail ?? '验证失败，检查 Key 与网络'}`}
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={!apiKey.trim() || verifying} onClick={() => void verify()}>
              {verifying ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {verifying ? '验证中…' : 'Verify'}
            </Button>
            <Button size="sm" className="ml-auto" disabled={!verified?.keyValid} onClick={() => void saveAndNext()}>
              下一步 <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="w-full space-y-3 rounded-2xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 text-[15px] font-semibold">
            <ShieldCheck className="size-4 text-primary" /> ② 选择审批档位
          </div>
          <RadioGroup value={tier} onValueChange={setTier} className="gap-2">
            {APPROVAL_TIERS.map((t) => (
              <label key={t.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${tier === t.id ? 'border-primary/60 bg-primary/5' : 'border-border hover:bg-muted/50'}`}>
                <RadioGroupItem value={t.id} className="mt-0.5" />
                <div>
                  <div className="text-[13px] font-medium">{t.title}</div>
                  <div className="text-[12px] text-muted-foreground">{t.desc}</div>
                </div>
              </label>
            ))}
          </RadioGroup>
          <div className="text-[11px] text-faint-foreground">之后可随时在 设置 → 浏览器权限 中调整。</div>
          <Button size="sm" className="w-full" onClick={() => void saveTier()}>
            完成 <ChevronRight className="size-3.5" />
          </Button>
        </div>
      )}

      {step === 3 && (
        <div className="w-full space-y-3 rounded-2xl border border-border bg-card p-5 text-center">
          <div className="text-[15px] font-semibold">🎉 就绪！试试第一条指令</div>
          <button
            type="button"
            onClick={() => onTryDemo('@当前页面 总结一下这个页面的要点')}
            className="w-full rounded-xl border border-primary/40 bg-primary/10 px-4 py-3 text-[13px] text-primary transition-colors hover:bg-primary/20"
          >
            「总结当前页面的要点」
          </button>
          <div className="text-[11px] text-faint-foreground">
            或直接输入任何问题；用 <span className="rounded bg-muted px-1 font-mono">@</span> 引用页面、
            <span className="rounded bg-muted px-1 font-mono">/</span> 调用命令。
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={onOpenSettings}
        className="text-[11px] text-faint-foreground underline-offset-2 hover:text-muted-foreground hover:underline"
      >
        跳过，稍后在设置中配置
      </button>
      {step === 1 && !verified?.keyValid && apiKey.trim() && !verifying && (
        <button
          type="button"
          onClick={() => { void saveAndNext(); toast.info('已保存未验证的连接，可稍后在设置中 Verify'); }}
          className="text-[11px] text-faint-foreground underline-offset-2 hover:text-muted-foreground hover:underline"
        >
          跳过验证直接保存
        </button>
      )}
    </div>
  );
}
