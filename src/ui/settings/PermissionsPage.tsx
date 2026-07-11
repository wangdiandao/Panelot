/**
 * Browser permissions settings (docs/06 §7, docs/09 §3.4): two-axis default
 * selector + rule table (tool × site × verdict × source, three-verdict
 * allow/ask/deny with manual add) + sensitive-origin blacklist block.
 * Built on shadcn/ui primitives.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../components/ui/field';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { GatekeeperService } from '../../gatekeeper/service';
import {
  ACTION_CATEGORIES,
  DEFAULT_SENSITIVE_PATTERNS,
  type PermissionRule,
} from '../../gatekeeper/rules';
import { SettingsStore, type GlobalSettings, storageGet, storageSet } from '../../settings/store';

const POLICY_DESC: Record<string, string> = {
  always: '全程询问：每一步都先征求同意，包括读取页面',
  untrusted: '操作询问：只自动放行只读操作，写操作弹审批（推荐默认）',
  'on-request': '读操作放行；写操作首次弹审批，本轮同站同工具后续放行',
  auto: '无需审批：写操作自动执行；敏感站点黑名单、敏感信息外发与 deny 规则仍然拦截',
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
  const [newRule, setNewRule] = useState<{
    tool: string;
    origin: string;
    verdict: PermissionRule['verdict'];
  }>({
    tool: '',
    origin: '*',
    verdict: 'ask',
  });

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

  const addRule = async () => {
    const tool = newRule.tool.trim();
    const origin = newRule.origin.trim() || '*';
    if (!tool) return;
    await GatekeeperService.addRule({
      tool,
      origin,
      verdict: newRule.verdict,
      source: 'user_setting',
    });
    setRules(await GatekeeperService.listRules());
    setNewRule({ tool: '', origin: '*', verdict: 'ask' });
    toast.success('规则已添加');
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

      <FieldGroup className="grid grid-cols-2 gap-4">
        <Field>
          <FieldLabel>Default approval policy</FieldLabel>
          <Select
            value={settings.defaultApprovalPolicy ?? 'untrusted'}
            onValueChange={(value) => void updateSettings({ defaultApprovalPolicy: value })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {Object.keys(POLICY_DESC).map((policy) => (
                  <SelectItem key={policy} value={policy}>
                    {policy}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>
            {POLICY_DESC[settings.defaultApprovalPolicy ?? 'untrusted']}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Default capability scope</FieldLabel>
          <Select
            value={normalizeScope(settings.defaultCapabilityScope)}
            onValueChange={(value) => void updateSettings({ defaultCapabilityScope: value })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {Object.keys(SCOPE_DESC).map((scope) => (
                  <SelectItem key={scope} value={scope}>
                    {scope}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>
            {SCOPE_DESC[normalizeScope(settings.defaultCapabilityScope)]}
          </FieldDescription>
        </Field>
      </FieldGroup>

      {/* Rule table */}
      <div className="space-y-2">
        <div className="text-[13px] font-medium text-muted-foreground">
          权限规则（allow / ask / deny）
        </div>
        {rules.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-center text-[12px] text-muted-foreground">
            暂无规则。审批时选择「本站始终」会在此生成持久规则，也可在下方手动添加。
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
                  <td
                    className={
                      r.verdict === 'deny'
                        ? 'text-destructive'
                        : r.verdict === 'ask'
                          ? 'text-warning'
                          : 'text-success'
                    }
                  >
                    {r.verdict}
                  </td>
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
        {/* Manual rule creation: tool name, prefix wildcard, or category:xxx */}
        <div className="flex gap-2">
          <Input
            value={newRule.tool}
            onChange={(e) => setNewRule({ ...newRule, tool: e.target.value })}
            placeholder="工具 / mcp__github__* / category:eval"
            className="flex-1 font-mono"
          />
          <Input
            value={newRule.origin}
            onChange={(e) => setNewRule({ ...newRule, origin: e.target.value })}
            placeholder="* 或 *.example.com"
            className="w-40 font-mono"
          />
          <Select
            value={newRule.verdict}
            onValueChange={(v) =>
              setNewRule({ ...newRule, verdict: v as PermissionRule['verdict'] })
            }
          >
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="allow">allow</SelectItem>
                <SelectItem value="ask">ask</SelectItem>
                <SelectItem value="deny">deny</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => void addRule()}>
            添加
          </Button>
        </div>
        <div className="text-[11px] text-muted-foreground">
          ask = 即使默认策略会放行也强制确认。类别：
          {Object.keys(ACTION_CATEGORIES)
            .map((c) => `category:${c}`)
            .join('、')}
        </div>
      </div>

      {/* Sensitive-origin blacklist */}
      <div className="space-y-2">
        <div className="text-[13px] font-medium text-muted-foreground">
          敏感站点黑名单（硬拒绝，不可被规则覆盖）
        </div>
        <div className="flex gap-2">
          <Input
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addSensitive()}
            placeholder="*.mybank.com"
            className="flex-1 font-mono"
          />
          <Button size="sm" onClick={() => void addSensitive()}>
            添加
          </Button>
        </div>
        {sensitive.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {sensitive.map((p) => (
              <Badge key={p} variant="outline" className="gap-1 font-mono text-[11px]">
                {p}
                <button
                  type="button"
                  onClick={() => void removeSensitive(p)}
                  aria-label={`移除 ${p}`}
                  className="text-muted-foreground hover:text-destructive"
                >
                  ×
                </button>
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
                <Badge key={p} variant="secondary" className="font-mono text-[11px]">
                  {p}
                </Badge>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
}
