/**
 * The composer's autonomy selector. Each option maps directly to an approval policy.
 */

import { ChevronDown, Eye, ShieldCheck, Zap } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Button } from './ui/button';
import { t } from '../i18n';
import type { PermissionPolicy } from '../../messaging/protocol';

export type PermissionTier = PermissionPolicy;

const TIERS: {
  id: PermissionTier;
  labelKey: string;
  hintKey: string;
  Icon: typeof Eye;
}[] = [
  { id: 'always', labelKey: 'perm.always', hintKey: 'perm.alwaysHint', Icon: Eye },
  { id: 'untrusted', labelKey: 'perm.balanced', hintKey: 'perm.balancedHint', Icon: ShieldCheck },
  { id: 'auto', labelKey: 'perm.auto', hintKey: 'perm.autoHint', Icon: Zap },
];

interface Props {
  /** Current policy (undefined = follow default, shown as 'untrusted'). */
  value: PermissionPolicy | undefined;
  onSelect: (tier: PermissionTier) => void;
}

export function PermissionSwitch({ value, onSelect }: Props) {
  const active =
    TIERS.find((tier) => tier.id === value) ?? TIERS.find((tier) => tier.id === 'untrusted');
  if (!active) return null;
  const { Icon } = active;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={t('perm.switch')}
          className="h-6 shrink-0 rounded-full"
        >
          <Icon data-icon="inline-start" />
          {t(active.labelKey)}
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-64">
        <DropdownMenuRadioGroup
          value={active.id}
          onValueChange={(value) => onSelect(value as PermissionTier)}
        >
          {TIERS.map((tier) => (
            <DropdownMenuRadioItem key={tier.id} value={tier.id}>
              <tier.Icon data-icon="inline-start" />
              <div className="flex min-w-0 flex-col">
                <span>{t(tier.labelKey)}</span>
                <span className="text-[11px] text-faint-foreground">{t(tier.hintKey)}</span>
              </div>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
