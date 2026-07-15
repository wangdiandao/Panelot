/**
 * Browser permissions settings (docs/06 §7, docs/09 §3.4): default permission
 * policy + rule table (tool × site × verdict × source, three-verdict
 * allow/ask/deny with manual add) + sensitive-origin blacklist block.
 * Built on shadcn/ui primitives.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '../components/ui/field';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { RadioGroup, RadioGroupItem } from '../components/ui/radio-group';
import { GatekeeperService } from '../../gatekeeper/service';
import {
  ACTION_CATEGORIES,
  DEFAULT_SENSITIVE_PATTERNS,
  type PermissionRule,
} from '../../gatekeeper/rules';
import {
  normalizeGlobalSettings,
  SettingsStore,
  type LegacyGlobalSettings,
  storageUpdate,
} from '../../settings/store';
import type { PermissionPolicy } from '../../messaging/protocol';
import { useStorageValue } from '../useStorageValue';
import { t } from '../i18n';

export const DEFAULT_PERMISSION_POLICIES = ['always', 'untrusted', 'auto'] as const;
export type DefaultPermissionPolicy = PermissionPolicy;

export function permissionPolicyLabel(policy: string): string {
  return t(`settings.permissions.policy.${policy}.label`);
}

export function permissionPolicyDescription(policy: string): string {
  return t(`settings.permissions.policy.${policy}.desc`);
}

export function permissionRuleSourceLabel(source: PermissionRule['source']): string {
  return t(`settings.permissions.source.${source}`);
}

export function PermissionsPage() {
  const storedSettings = useStorageValue<LegacyGlobalSettings | null>('global_settings', null);
  const settings = normalizeGlobalSettings(storedSettings ?? {});
  const rules = useStorageValue<PermissionRule[] | null>('permission_rules', null) ?? [];
  const sensitive = useStorageValue<string[] | null>('sensitive_origins', null) ?? [];
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

  const defaultPermissionPolicy = settings.defaultPermissionPolicy ?? 'untrusted';

  const removeRule = async (id: string) => {
    await GatekeeperService.removeRule(id);
    toast.success(t('settings.permissions.ruleDeleted'));
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
    setNewRule({ tool: '', origin: '*', verdict: 'ask' });
    toast.success(t('settings.permissions.ruleAdded'));
  };

  const addSensitive = async () => {
    const p = newPattern.trim();
    if (!p) return;
    setNewPattern('');
    await storageUpdate<string[]>('sensitive_origins', [], (current) =>
      current.includes(p) ? current : [...current, p],
    );
  };

  const removeSensitive = async (p: string) => {
    await storageUpdate<string[]>('sensitive_origins', [], (current) =>
      current.filter((pattern) => pattern !== p),
    );
  };

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h2 className="text-[15px] font-semibold">{t('settings.section.permissions')}</h2>

      <FieldSet>
        <FieldLegend variant="label">{t('settings.permissions.defaultPolicy')}</FieldLegend>
        <RadioGroup
          value={defaultPermissionPolicy}
          onValueChange={(value) =>
            void SettingsStore.global.patch({
              defaultPermissionPolicy: value as DefaultPermissionPolicy,
            })
          }
          className="grid-cols-1 md:grid-cols-3"
        >
          {DEFAULT_PERMISSION_POLICIES.map((policy) => {
            const id = `default-permission-policy-${policy}`;
            return (
              <FieldLabel key={policy} htmlFor={id}>
                <Field orientation="horizontal">
                  <RadioGroupItem id={id} value={policy} />
                  <FieldContent>
                    <FieldTitle>{permissionPolicyLabel(policy)}</FieldTitle>
                    <FieldDescription>{permissionPolicyDescription(policy)}</FieldDescription>
                  </FieldContent>
                </Field>
              </FieldLabel>
            );
          })}
        </RadioGroup>
      </FieldSet>

      {/* Rule table */}
      <div className="flex flex-col gap-2">
        <div className="text-[13px] font-medium text-muted-foreground">
          {t('settings.permissions.rules')}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {t('settings.permissions.rulesHint')}
        </div>
        {rules.length === 0 ? (
          <Empty className="border border-dashed p-4 md:p-4">
            <EmptyHeader>
              <EmptyTitle className="text-sm">{t('settings.permissions.rules')}</EmptyTitle>
              <EmptyDescription>{t('settings.permissions.emptyRules')}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="max-w-full overflow-x-auto">
            <table className="w-full min-w-[34rem] text-[12px]">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-1">{t('settings.permissions.tool')}</th>
                  <th>{t('settings.permissions.site')}</th>
                  <th>{t('settings.permissions.verdict')}</th>
                  <th>{t('settings.permissions.source')}</th>
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
                      {t(`settings.permissions.verdict.${r.verdict}`)}
                    </td>
                    <td className="text-muted-foreground">{permissionRuleSourceLabel(r.source)}</td>
                    <td className="text-right">
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-6 px-2 text-[12px]"
                        onClick={() => void removeRule(r.id)}
                      >
                        {t('settings.permissions.removeRule')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* Manual rule creation: tool name, prefix wildcard, or category:xxx */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={newRule.tool}
            onChange={(e) => setNewRule({ ...newRule, tool: e.target.value })}
            placeholder={t('settings.permissions.toolPlaceholder')}
            className="flex-1 font-mono"
          />
          <Input
            value={newRule.origin}
            onChange={(e) => setNewRule({ ...newRule, origin: e.target.value })}
            placeholder={t('settings.permissions.originPlaceholder')}
            className="font-mono sm:w-40"
          />
          <Select
            value={newRule.verdict}
            onValueChange={(v) =>
              setNewRule({ ...newRule, verdict: v as PermissionRule['verdict'] })
            }
          >
            <SelectTrigger
              className="w-full sm:w-28"
              aria-label={t('settings.permissions.verdict')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="allow">{t('settings.permissions.verdict.allow')}</SelectItem>
                <SelectItem value="ask">{t('settings.permissions.verdict.ask')}</SelectItem>
                <SelectItem value="deny">{t('settings.permissions.verdict.deny')}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => void addRule()}>
            {t('settings.permissions.add')}
          </Button>
        </div>
        <div className="text-[11px] text-muted-foreground">
          {t('settings.permissions.askHint', {
            categories: Object.keys(ACTION_CATEGORIES)
              .map((category) => `category:${category}`)
              .join(', '),
          })}
        </div>
      </div>

      {/* Sensitive-origin blacklist */}
      <div className="flex flex-col gap-2">
        <div className="text-[13px] font-medium text-muted-foreground">
          {t('settings.permissions.sensitive')}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addSensitive()}
            placeholder="*.mybank.com"
            className="flex-1 font-mono"
          />
          <Button size="sm" onClick={() => void addSensitive()}>
            {t('settings.permissions.add')}
          </Button>
        </div>
        {sensitive.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {sensitive.map((p) => (
              <Badge key={p} variant="outline" className="gap-1 font-mono text-[11px]">
                {p}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void removeSensitive(p)}
                  aria-label={t('settings.permissions.removeSensitive', { pattern: p })}
                >
                  ×
                </Button>
              </Badge>
            ))}
          </div>
        )}
        <Collapsible className="text-[11px] text-muted-foreground">
          <CollapsibleTrigger className="cursor-pointer hover:text-foreground">
            {t('settings.permissions.showBuiltIn', {
              n: DEFAULT_SENSITIVE_PATTERNS.length,
            })}
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
