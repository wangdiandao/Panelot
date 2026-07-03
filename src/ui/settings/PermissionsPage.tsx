/**
 * Browser permissions settings (docs/06 §7, docs/09 §3.4): two-axis default
 * selector + rule table (tool × site × verdict × source) + sensitive-origin
 * blacklist block. Built on shadcn/ui primitives.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { GatekeeperService } from '../../gatekeeper/service';
import { DEFAULT_SENSITIVE_PATTERNS, type PermissionRule } from '../../gatekeeper/rules';
import { SettingsStore, type GlobalSettings, storageGet, storageSet } from '../../settings/store';

const POLICY_DESC: Record<string, string> = {
  untrusted: '只自动放行只读操作，其余一律弹审批（推荐默认）',
  'on-request': '读操作放行；写操作首次弹审批，本轮同站同工具后续放行',
  never: '从不弹窗 = 需要审批的动作直接拒绝（绝非自动批准）',
  granular: '完全按规则表裁决，未覆盖的按 untrusted 兜底',
};

// Blacklist-only model: reads are never gated; writes are either fully
// blocked (read-only) or allowed subject to approval policy + blacklist.
const SCOPE_DESC: Record<string, string> = {
  'read-only': '只能读，一切写操作被拒绝',
  full: '读不拦截；写操作按审批策略执行（仍受黑名单与 deny 规则约束）',
};

/** Legacy whitelist-era values (same-origin-write / cross-origin) → full. */
const normalizeScope = (v: string | undefined): string =>
  v === 'read-only' ? 'read-only' : 'full';

export function PermissionsPage() {
  const [settings, setSettings] = useState<GlobalSettings>({});
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [sensitive, setSensitive] = useState<string[]>([]);
  const [newPattern, setNewPattern] = useState('');

  useEffect(() => {
    void SettingsStore.global.get().then(setSettings);
    void GatekeeperService.listRules().then(setRules);
    void storageGet<string[]>('sensitive_origins', []).then(setSensitive);
  }, []);

  const updateSettings = async (patch: Partial<GlobalSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await SettingsStore.global.set(next);
  };

  const removeRule = async (id: string) => {
    await GatekeeperService.removeRule(id);
    setRules(await GatekeeperService.listRules());
    toast.success('规则已删除');
  };

  const addSensitive = async () => {
    const p = newPattern.trim();
    if (!p) return;
    const next = [...sensitive, p];
    setSensitive(next);
    setNewPattern('');
    await storageSet('sensitive_origins', next);
  };

  const removeSensitive = async (p: string) => {
    const next = sensitive.filter((x) => x !== p);
    setSensitive(next);
    await storageSet('sensitive_origins', next);
  };

  return (
    <div className="max-w-2xl space-y-6">
      <h2 className="text-[15px] font-semibold">浏览器权限</h2>

      {/* Two-axis defaults */}
      <div className="space-y-3">
        <div className="text-[13px] font-medium text-muted-foreground">默认两轴档位</div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label className="mb-1 block text-[12px] text-muted-foreground">审批策略（何时问）</Label>
            <Select
              value={settings.defaultApprovalPolicy ?? 'untrusted'}
              onValueChange={(v) => void updateSettings({ defaultApprovalPolicy: v })}
            >
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.keys(POLICY_DESC).map((k) => (
                  <SelectItem key={k} value={k}>{k}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="mt-1 text-[11px] text-muted-foreground">{POLICY_DESC[settings.defaultApprovalPolicy ?? 'untrusted']}</div>
          </div>
          <div>
            <Label className="mb-1 block text-[12px] text-muted-foreground">能力域（能做什么·硬闸）</Label>
            <Select
              value={normalizeScope(settings.defaultCapabilityScope)}
              onValueChange={(v) => void updateSettings({ defaultCapabilityScope: v })}
            >
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.keys(SCOPE_DESC).map((k) => (
                  <SelectItem key={k} value={k}>{k}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="mt-1 text-[11px] text-muted-foreground">{SCOPE_DESC[normalizeScope(settings.defaultCapabilityScope)]}</div>
          </div>
        </div>
      </div>

      {/* Rule table */}
      <div className="space-y-2">
        <div className="text-[13px] font-medium text-muted-foreground">权限规则</div>
        {rules.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-center text-[12px] text-muted-foreground">
            暂无规则。审批时选择「本站始终」会在此生成持久规则。
          </div>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-1">工具</th>
                <th>站点</th>
                <th>裁决</th>
                <th>来源</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-b border-border/50">
                  <td className="py-1 font-mono">{r.tool}</td>
                  <td className="font-mono">{r.origin}</td>
                  <td className={r.verdict === 'deny' ? 'text-destructive' : 'text-success'}>{r.verdict}</td>
                  <td className="text-muted-foreground">{r.source}</td>
                  <td className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[12px] text-muted-foreground hover:text-destructive"
                      onClick={() => void removeRule(r.id)}
                    >
                      删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Sensitive-origin blacklist */}
      <div className="space-y-2">
        <div className="text-[13px] font-medium text-muted-foreground">敏感站点黑名单（硬拒绝，不可被规则覆盖）</div>
        <div className="flex gap-2">
          <Input
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addSensitive()}
            placeholder="*.mybank.com"
            className="flex-1 font-mono"
          />
          <Button size="sm" onClick={() => void addSensitive()}>添加</Button>
        </div>
        {sensitive.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {sensitive.map((p) => (
              <Badge key={p} variant="outline" className="gap-1 font-mono text-[11px]">
                {p}
                <button type="button" onClick={() => void removeSensitive(p)} aria-label={`移除 ${p}`} className="text-muted-foreground hover:text-destructive">×</button>
              </Badge>
            ))}
          </div>
        )}
        <Collapsible className="text-[11px] text-muted-foreground">
          <CollapsibleTrigger className="cursor-pointer hover:text-foreground">
            查看 {DEFAULT_SENSITIVE_PATTERNS.length} 条预置黑名单
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-1 flex flex-wrap gap-1">
              {DEFAULT_SENSITIVE_PATTERNS.map((p) => (
                <Badge key={p} variant="secondary" className="font-mono text-[11px]">{p}</Badge>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
}
