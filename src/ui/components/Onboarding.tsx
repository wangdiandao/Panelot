/**
 * Onboarding (docs/09 §3.3, OB-1 "first answer ≤2min"): three-step flow shown
 * in the empty conversation when no provider is configured.
 *   ① pick the interface type + base URL + key, inline Verify (green on success)
 *   ② choose the default permission policy
 *   ③ demo prompt card ("try: @当前页面 总结一下")
 * Skippable — a "稍后配置" link falls back to the settings modal.
 * No vendor list here: the wire protocol is the only fork that matters, so
 * the flow is interface type → endpoint domain → key.
 */

import { useRef, useState } from 'react';
import { Check, ChevronRight, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from './ui/field';
import { Alert, AlertDescription } from './ui/alert';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { createAdapter, normalizeBaseUrl } from '../../providers/registry';
import type { Connection, VerifyResult } from '../../providers/types';
import { SettingsStore } from '../../settings/store';
import { encryptSecret } from '../../settings/crypto';
import { hostPermissionBroker } from '../../permissions/hostPermissionBroker';
import { cn } from '../lib/utils';
import { t } from '../i18n';
import type { PermissionPolicy } from '../../messaging/protocol';

const APPROVAL_TIERS: {
  id: PermissionPolicy;
  titleKey: string;
  descKey: string;
}[] = [
  {
    id: 'always',
    titleKey: 'settings.permissions.policy.always.label',
    descKey: 'settings.permissions.policy.always.desc',
  },
  {
    id: 'untrusted',
    titleKey: 'settings.permissions.policy.untrusted.label',
    descKey: 'settings.permissions.policy.untrusted.desc',
  },
  {
    id: 'auto',
    titleKey: 'settings.permissions.policy.auto.label',
    descKey: 'settings.permissions.policy.auto.desc',
  },
];

interface Props {
  onConfigured: () => void;
  onOpenSettings: () => void;
  onTryDemo: (text: string) => void;
}

export function onboardingConnectionFingerprint(
  kind: Connection['kind'],
  baseUrl: string,
  apiKey: string,
): string {
  return JSON.stringify([kind, baseUrl.trim(), apiKey.trim()]);
}

export function Onboarding({ onConfigured, onOpenSettings, onTryDemo }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [kind, setKind] = useState<Connection['kind']>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState<VerifyResult | null>(null);
  const [verifiedFingerprint, setVerifiedFingerprint] = useState<string | null>(null);
  const [tier, setTier] = useState<PermissionPolicy>('untrusted');
  const verificationGeneration = useRef(0);
  const connectionId = useRef(crypto.randomUUID());
  const currentFingerprint = onboardingConnectionFingerprint(kind, baseUrl, apiKey);
  const hasCurrentVerification =
    verified?.keyValid === true && verifiedFingerprint === currentFingerprint;

  const invalidateVerification = () => {
    verificationGeneration.current += 1;
    setVerifying(false);
    setVerified(null);
    setVerifiedFingerprint(null);
  };

  const buildConnection = (): Connection | null => {
    if (!baseUrl.trim()) return null;
    const { url } = normalizeBaseUrl(baseUrl.trim(), kind);
    return {
      id: connectionId.current,
      name: (() => {
        try {
          return new URL(url).hostname;
        } catch {
          return url;
        }
      })(),
      kind,
      baseUrl: url,
      apiKeys: apiKey.trim() ? [apiKey.trim()] : [],
      enabled: true,
    };
  };

  const verify = async () => {
    const generation = ++verificationGeneration.current;
    const fingerprint = currentFingerprint;
    setVerifying(true);
    setVerified(null);
    setVerifiedFingerprint(null);
    try {
      const conn = buildConnection();
      if (!conn) return;
      try {
        await hostPermissionBroker.request(conn.baseUrl);
      } catch {
        /* non-extension env */
      }
      if (generation !== verificationGeneration.current) return;
      const result = await createAdapter(conn).verify();
      if (generation !== verificationGeneration.current) return;
      setVerified(result);
      setVerifiedFingerprint(fingerprint);
    } catch {
      if (generation !== verificationGeneration.current) return;
      setVerified({
        reachable: false,
        keyValid: false,
        streaming: false,
        toolUse: false,
      });
      setVerifiedFingerprint(fingerprint);
    } finally {
      if (generation === verificationGeneration.current) setVerifying(false);
    }
  };

  const saveAndNext = async (allowUnverified = false) => {
    if (!allowUnverified && !hasCurrentVerification) return;
    const conn = buildConnection();
    if (!conn) return;
    await SettingsStore.connections.upsert({
      ...conn,
      apiKeys: await Promise.all(conn.apiKeys.map(encryptSecret)),
    });
    setStep(2);
  };

  const saveTier = async () => {
    const tierOption = APPROVAL_TIERS.find((option) => option.id === tier);
    if (!tierOption) return;
    await SettingsStore.global.patch({
      defaultPermissionPolicy: tierOption.id,
    });
    setStep(3);
    onConfigured();
  };

  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-4 px-4 py-6">
      <div className="flex items-center gap-2 text-[12px] text-faint-foreground">
        {[1, 2, 3].map((n) => (
          <span
            key={n}
            className={cn(
              'flex size-5 items-center justify-center rounded-full text-[11px]',
              step >= n ? 'bg-primary text-primary-foreground' : 'bg-muted',
            )}
          >
            {step > n ? <Check className="size-3" /> : n}
          </span>
        ))}
      </div>

      {step === 1 && (
        <Card className="w-full gap-4">
          <CardHeader>
            <CardTitle>① {t('onboarding.connect')}</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="ob-kind">{t('settings.providers.kind')}</FieldLabel>
                <Select
                  value={kind}
                  onValueChange={(v) => {
                    setKind(v as Connection['kind']);
                    invalidateVerification();
                  }}
                >
                  <SelectTrigger id="ob-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="openai">
                        {t('settings.providers.kind.openai')} (/chat/completions)
                      </SelectItem>
                      <SelectItem value="anthropic">
                        {t('settings.providers.kind.anthropic')} (/v1/messages)
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="ob-url">{t('onboarding.baseUrl')}</FieldLabel>
                <Input
                  id="ob-url"
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value);
                    invalidateVerification();
                  }}
                  placeholder={
                    kind === 'anthropic'
                      ? 'https://api.anthropic.com'
                      : 'https://api.example.com/v1'
                  }
                  className="font-mono"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="ob-key">{t('onboarding.apiKey')}</FieldLabel>
                <Input
                  id="ob-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    invalidateVerification();
                  }}
                  placeholder="sk-…"
                  className="font-mono"
                />
              </Field>
              {verified &&
                (verified.keyValid ? (
                  <Alert variant="success">
                    <Check />
                    <AlertDescription>
                      {t('onboarding.connected')}
                      {verified.models?.length
                        ? t('onboarding.modelsFound', { n: verified.models.length })
                        : ''}
                    </AlertDescription>
                  </Alert>
                ) : (
                  <Alert variant="destructive">
                    <AlertDescription>{t('onboarding.failed')}</AlertDescription>
                  </Alert>
                ))}
            </FieldGroup>
          </CardContent>
          <CardFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={!baseUrl.trim() || verifying}
              onClick={() => void verify()}
            >
              {verifying ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
              {verifying ? t('settings.providers.verifying') : t('settings.providers.verify')}
            </Button>
            <Button
              size="sm"
              className="ml-auto"
              disabled={!hasCurrentVerification}
              onClick={() => void saveAndNext()}
            >
              {t('onboarding.next')} <ChevronRight data-icon="inline-end" />
            </Button>
          </CardFooter>
        </Card>
      )}

      {step === 2 && (
        <Card className="w-full gap-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck aria-hidden="true" /> ② {t('onboarding.approval')}
            </CardTitle>
            <CardDescription>{t('onboarding.approvalHint')}</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldSet>
              <FieldLegend className="sr-only">{t('onboarding.approval')}</FieldLegend>
              <RadioGroup
                value={tier}
                onValueChange={(value) => setTier(value as PermissionPolicy)}
                className="gap-2"
              >
                {APPROVAL_TIERS.map((tierOption) => (
                  <FieldLabel key={tierOption.id} htmlFor={`tier-${tierOption.id}`}>
                    <Field orientation="horizontal">
                      <RadioGroupItem id={`tier-${tierOption.id}`} value={tierOption.id} />
                      <FieldContent>
                        <FieldTitle>{t(tierOption.titleKey)}</FieldTitle>
                        <FieldDescription>{t(tierOption.descKey)}</FieldDescription>
                      </FieldContent>
                    </Field>
                  </FieldLabel>
                ))}
              </RadioGroup>
            </FieldSet>
          </CardContent>
          <CardFooter>
            <Button size="sm" className="w-full" onClick={() => void saveTier()}>
              {t('onboarding.finish')} <ChevronRight data-icon="inline-end" />
            </Button>
          </CardFooter>
        </Card>
      )}

      {step === 3 && (
        <Card className="w-full gap-4 text-center">
          <CardHeader>
            <CardTitle>🎉 {t('onboarding.ready')}</CardTitle>
            <CardDescription>{t('onboarding.demoHint')}</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button
              variant="outline"
              onClick={() => onTryDemo(t('onboarding.demo'))}
              className="h-auto w-full rounded-xl py-3"
            >
              {t('onboarding.demo')}
            </Button>
          </CardFooter>
        </Card>
      )}

      <Button variant="link" size="sm" onClick={onOpenSettings}>
        {t('onboarding.skip')}
      </Button>
      {step === 1 && !hasCurrentVerification && baseUrl.trim() && !verifying && (
        <Button
          variant="link"
          size="sm"
          onClick={() => {
            void saveAndNext(true);
            void import('sonner').then(({ toast }) => toast.info(t('onboarding.savedUnverified')));
          }}
        >
          {t('onboarding.skipVerify')}
        </Button>
      )}
    </div>
  );
}
