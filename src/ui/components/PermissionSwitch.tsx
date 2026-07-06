/**
 * PermissionSwitch (docs/06 §1, owner decision 2026-07-05): the composer's
 * autonomy selector — permission TIER, not tool list.
 *
 * Four options:
 *  - always   (全程询问)  every step asks, reads included
 *  - untrusted (操作询问) reads free, writes ask (default)
 *  - auto     (无需审批)  writes auto-approved; safety floor intact
 *  - plan     (计划模式)  pseudo-tier: agent plans first, user confirms before execution
 *
 * 'plan' is a UI-only mode — not an ApprovalPolicy value. When selected,
 * planMode=true is communicated via onSelectPlan(); the underlying
 * approvalPolicy stays at 'untrusted' during planning.
 */

import { Check, ChevronDown, ClipboardList, Eye, ShieldCheck, Zap } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { cn } from '../lib/utils';
import { t } from '../i18n';
import type { ApprovalPolicy } from '../../messaging/protocol';

/** Composer-facing tiers (includes the UI-only 'plan' pseudo-tier). */
export type PermissionTier = Extract<ApprovalPolicy, 'always' | 'untrusted' | 'auto'> | 'plan';

const TIERS: { id: PermissionTier; labelKey: string; hintKey: string; Icon: typeof Eye; isPlan?: boolean }[] = [
  { id: 'plan', labelKey: 'perm.plan', hintKey: 'perm.planHint', Icon: ClipboardList, isPlan: true },
  { id: 'always', labelKey: 'perm.always', hintKey: 'perm.alwaysHint', Icon: Eye },
  { id: 'untrusted', labelKey: 'perm.balanced', hintKey: 'perm.balancedHint', Icon: ShieldCheck },
  { id: 'auto', labelKey: 'perm.auto', hintKey: 'perm.autoHint', Icon: Zap },
];

interface Props {
  /** Current policy (undefined = follow default, shown as 'untrusted'). */
  value: ApprovalPolicy | undefined;
  /** Whether plan mode is currently active. */
  planMode?: boolean;
  onSelect: (tier: PermissionTier) => void;
}

export function PermissionSwitch({ value, planMode, onSelect }: Props) {
  const active = planMode ? TIERS[0]! : (TIERS.find((m) => m.id === value && !m.isPlan) ?? TIERS[2]!);
  const { Icon } = active;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('perm.switch')}
          className={cn(
            'flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors',
            active.isPlan
              ? 'border-info/40 bg-info/10 text-info'
              : active.id === 'auto'
              ? 'border-warning/40 bg-warning/10 text-warning'
              : 'border-primary/30 bg-primary/10 text-primary',
          )}
        >
          <Icon className="size-3" />
          {t(active.labelKey)}
          <ChevronDown className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-64">
        {TIERS.map((m) => (
          <DropdownMenuItem key={m.id} onClick={() => onSelect(m.id)}>
            <Check className={cn('size-4', (m.isPlan ? planMode : m.id === active.id && !planMode) ? 'opacity-100' : 'opacity-0')} />
            <m.Icon className="size-4 text-muted-foreground" />
            <div className="flex min-w-0 flex-col">
              <span>{t(m.labelKey)}</span>
              <span className="text-[11px] text-faint-foreground">{t(m.hintKey)}</span>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
