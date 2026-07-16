/**
 * Providers settings (docs/09 §3.4): connection cards → edit form with
 * template picker, multi-key textarea, custom headers, quirks, inline Verify
 * with structured results. Built on shadcn/ui primitives.
 */

import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Switch } from '../components/ui/switch';
import { Checkbox } from '../components/ui/checkbox';
import { Badge } from '../components/ui/badge';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '../components/ui/item';
import { Alert, AlertDescription } from '../components/ui/alert';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '../components/ui/empty';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '../components/ui/field';
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
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { createAdapter, normalizeBaseUrl } from '../../providers/registry';
import {
  ProviderError,
  type Connection,
  type ProviderErrorKind,
  type QuirkFlags,
  type VerifyResult,
} from '../../providers/types';
import { SettingsStore, type GlobalSettings } from '../../settings/store';
import { useStorageValue } from '../useStorageValue';
import {
  decryptHeaderValue,
  decryptSecret,
  encryptHeaderValue,
  encryptSecret,
  isEncrypted,
} from '../../settings/crypto';
import { hostPermissionBroker } from '../../permissions/hostPermissionBroker';
import { ModelSelector } from '../components/ModelSelector';
import { ProviderErrorNotice } from '../components/ProviderErrorNotice';
import { cn } from '../lib/utils';
import type { ProviderErrorViewInput } from '../providerErrorPresentation';
import { t } from '../i18n';

const VERIFY_KIND: Record<NonNullable<VerifyResult['failure']>, string> = {
  invalid_key: 'auth',
  unreachable: 'network',
  needs_host_permission: 'network',
  protocol_mismatch: 'protocol',
};

function failureText(failure: NonNullable<VerifyResult['failure']>): string {
  if (failure === 'invalid_key')
    return `${t('error.reason.invalid_key')} — ${t('error.guidance.invalid_key')}`;
  if (failure === 'unreachable') return `${t('error.network')} — ${t('error.guidance.network')}`;
  if (failure === 'needs_host_permission')
    return `${t('settings.providers.needsHostPermission')} — ${t('settings.providers.needsHostPermissionHint')}`;
  return `${t('error.protocol')} — ${t('error.guidance.protocol')}`;
}

export function providerErrorFromVerifyResult(
  result: VerifyResult,
): ProviderErrorViewInput | undefined {
  if (!result.failure) return undefined;
  const hasStructuredDetails =
    result.details !== undefined &&
    Object.values(result.details).some((value) => value !== undefined);
  return {
    message: hasStructuredDetails
      ? (result.detail ?? failureText(result.failure))
      : failureText(result.failure),
    kind: VERIFY_KIND[result.failure],
    ...(hasStructuredDetails ? { details: result.details } : {}),
  };
}

function verifyFailureForProviderKind(
  kind: ProviderErrorKind,
): NonNullable<VerifyResult['failure']> {
  if (kind === 'auth') return 'invalid_key';
  if (kind === 'protocol') return 'protocol_mismatch';
  return 'unreachable';
}

function requestVerifyFailure(error: unknown): VerifyResult {
  const safeError = t('settings.providers.verifyRequestError');
  if (error instanceof ProviderError) {
    const details = {
      ...(error.details.status === undefined ? {} : { status: error.details.status }),
      ...(error.details.reason === undefined ? {} : { reason: error.details.reason }),
      raw: safeError,
    };
    return {
      reachable: false,
      keyValid: false,
      streaming: false,
      toolUse: false,
      failure: verifyFailureForProviderKind(error.kind),
      detail: safeError,
      details,
    };
  }
  return {
    reachable: false,
    keyValid: false,
    streaming: false,
    toolUse: false,
    failure: 'unreachable',
    detail: safeError,
    details: { raw: safeError },
  };
}

function VerifyStatus({ result }: { result: VerifyResult }) {
  return (
    <div className="flex flex-wrap gap-3 text-[13px]">
      <span className={cn(result.reachable ? 'text-success' : 'text-destructive')}>
        {result.reachable ? '✓' : '✗'} {t('settings.providers.reachable')}
      </span>
      <span className={cn(result.keyValid ? 'text-success' : 'text-destructive')}>
        {result.keyValid ? '✓' : '✗'} {t('settings.providers.keyValid')}
      </span>
      <span className={cn(result.streaming ? 'text-success' : 'text-muted-foreground')}>
        {result.streaming ? '✓' : '—'} {t('settings.providers.streaming')}
      </span>
      <span className={cn(result.toolUse ? 'text-success' : 'text-muted-foreground')}>
        {result.toolUse ? '✓' : '—'} {t('settings.providers.toolUse')}
      </span>
    </div>
  );
}

export function ProvidersPage() {
  const storedConnections = useStorageValue<Connection[] | null>('connections', null);
  const globalSettings = useStorageValue<GlobalSettings | null>('global_settings', null);
  const connections = storedConnections ?? [];
  const [editing, setEditing] = useState<Connection | null>(null);
  const [deleting, setDeleting] = useState<Connection | null>(null);
  const defaultModel = globalSettings?.defaultModel ?? null;

  const saveDefaultModel = async (model: { connectionId: string; modelId: string }) => {
    await SettingsStore.global.patch({ defaultModel: model });
    toast.success(t('settings.providers.defaultSet'));
  };

  const clearDefaultModelForConnection = async (connectionId: string) => {
    if (connections.some((connection) => connection.id !== connectionId && connection.enabled)) {
      return;
    }
    const settings = await SettingsStore.global.get();
    if (settings.defaultModel?.connectionId === connectionId) {
      await SettingsStore.global.patch({ defaultModel: undefined });
    }
  };

  const setConnectionEnabled = async (connection: Connection, enabled: boolean) => {
    await SettingsStore.connections.upsert({ ...connection, enabled });
    if (!enabled) await clearDefaultModelForConnection(connection.id);
  };

  const removeConnection = async (connection: Connection) => {
    await SettingsStore.connections.remove(connection.id);
    await clearDefaultModelForConnection(connection.id);
    toast.success(t('settings.providers.deleted'));
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
    await SettingsStore.connections.upsert(encrypted);
    setEditing(null);
    toast.success(t('settings.providers.saved'));
  };

  if (editing) {
    return (
      <ConnectionForm connection={editing} onSave={upsert} onCancel={() => setEditing(null)} />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center">
        <h2 className="text-[15px] font-semibold">{t('settings.providers.title')}</h2>
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
          <Plus data-icon="inline-start" /> {t('settings.providers.add')}
        </Button>
      </div>
      {connections.length === 0 && (
        <Empty className="border border-dashed p-6 md:p-6">
          <EmptyHeader>
            <EmptyTitle className="text-base">{t('settings.providers.emptyTitle')}</EmptyTitle>
            <EmptyDescription>{t('settings.providers.emptyHint')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              size="sm"
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
              <Plus data-icon="inline-start" /> {t('settings.providers.add')}
            </Button>
          </EmptyContent>
        </Empty>
      )}
      {connections.length > 0 && (
        <Item variant="outline" size="sm">
          <ItemContent>
            <ItemTitle>{t('settings.providers.defaultModel')}</ItemTitle>
            <ItemDescription>{t('settings.providers.defaultModelHint')}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <ModelSelector
              value={defaultModel}
              allowDefaultSelection={false}
              onSelect={(choice) => {
                if (choice)
                  void saveDefaultModel({
                    connectionId: choice.connectionId,
                    modelId: choice.modelId,
                  });
              }}
            />
          </ItemActions>
        </Item>
      )}
      <ItemGroup className="gap-2">
        {connections.map((c) => (
          <Item key={c.id} variant="outline" size="sm">
            <Switch
              checked={c.enabled}
              onCheckedChange={(on) => void setConnectionEnabled(c, on)}
              aria-label={t('settings.providers.enable', { name: c.name || c.baseUrl })}
            />
            <ItemContent className="min-w-0">
              <ItemTitle>{c.name || c.baseUrl}</ItemTitle>
              <ItemDescription className="truncate font-mono">
                {c.kind} · {c.baseUrl} · {c.apiKeys.length} key{c.apiKeys.length === 1 ? '' : 's'}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button variant="outline" size="sm" onClick={() => setEditing(c)}>
                {t('settings.providers.edit')}
              </Button>
              <Button variant="destructive" size="sm" onClick={() => setDeleting(c)}>
                {t('settings.providers.delete')}
              </Button>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings.providers.deleteTitle', {
                name: deleting?.name || deleting?.baseUrl || '',
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('settings.providers.deleteHint')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('app.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) {
                  void removeConnection(deleting);
                }
                setDeleting(null);
              }}
            >
              {t('settings.providers.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------

type ProviderField = 'baseUrl' | 'headers' | 'modelConfig';

class ProviderFieldError extends Error {
  constructor(
    readonly field: ProviderField,
    message: string,
  ) {
    super(message);
  }
}

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
  const keyHydrationGeneration = useRef(0);
  const headerHydrationGeneration = useRef(0);
  const keysDirty = useRef(false);
  const headersDirty = useRef(false);

  // Decrypt stored keys for display when editing an existing connection.
  useEffect(() => {
    const generation = ++keyHydrationGeneration.current;
    keysDirty.current = false;
    void Promise.all(
      connection.apiKeys.map((k) => (isEncrypted(k) ? decryptSecret(k) : Promise.resolve(k))),
    ).then((keys) => {
      if (keyHydrationGeneration.current === generation && !keysDirty.current) {
        setKeysText(keys.join('\n'));
      }
    });
    return () => {
      if (keyHydrationGeneration.current === generation) keyHydrationGeneration.current += 1;
    };
  }, [connection.apiKeys, connection.id]);
  useEffect(() => {
    const generation = ++headerHydrationGeneration.current;
    headersDirty.current = false;
    if (!connection.customHeaders) {
      // Reset the editor when switching to a connection without persisted headers.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHeadersText('');
      return;
    }
    void Promise.all(
      Object.entries(connection.customHeaders).map(
        async ([name, value]) =>
          [name, await decryptHeaderValue(connection.id, name, value)] as const,
      ),
    ).then((headers) => {
      if (headerHydrationGeneration.current === generation && !headersDirty.current) {
        setHeadersText(headers.map(([name, value]) => `${name}: ${value}`).join('\n'));
      }
    });
    return () => {
      if (headerHydrationGeneration.current === generation) {
        headerHydrationGeneration.current += 1;
      }
    };
  }, [connection.customHeaders, connection.id]);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [urlHint, setUrlHint] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ProviderField, string>>>({});

  const built = (): Connection => {
    let normalized: ReturnType<typeof normalizeBaseUrl>;
    try {
      normalized = normalizeBaseUrl(conn.baseUrl, conn.kind);
    } catch {
      throw new ProviderFieldError('baseUrl', t('settings.providers.invalidEndpoint'));
    }
    const { url, hint } = normalized;
    setUrlHint(hint ? t('settings.providers.baseUrlHint') : undefined);
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(modelConfigText);
      } catch {
        throw new ProviderFieldError('modelConfig', t('settings.providers.invalidModelJson'));
      }
      try {
        models = parseModelConfigs(parsed);
      } catch (error) {
        throw new ProviderFieldError(
          'modelConfig',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    let customHeaders: Record<string, string>;
    try {
      customHeaders = Object.fromEntries(
        headersText
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line, index) => {
            const separator = line.indexOf(':');
            if (separator <= 0) {
              throw new Error(t('settings.providers.invalidHeader', { line: index + 1 }));
            }
            return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
          }),
      );
    } catch (error) {
      throw new ProviderFieldError(
        'headers',
        error instanceof Error ? error.message : String(error),
      );
    }
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

  const handleConfigurationError = (error: unknown) => {
    if (error instanceof ProviderFieldError) {
      setFieldErrors((current) => ({ ...current, [error.field]: error.message }));
      setFormError(null);
      return;
    }
    setFormError(
      error instanceof Error && error.message.trim()
        ? error.message
        : t('settings.providers.invalidConfiguration'),
    );
  };

  const verify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    setFormError(null);
    setFieldErrors({});
    let phase: 'configuration' | 'request' = 'configuration';
    try {
      const candidate = built();
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
      const adapter = createAdapter(candidate);
      phase = 'request';
      const result = await adapter.verify();
      setVerifyResult(result);
    } catch (error) {
      if (phase === 'configuration') {
        handleConfigurationError(error);
      } else {
        setVerifyResult(requestVerifyFailure(error));
      }
    } finally {
      setVerifying(false);
    }
  };

  const verifyError = verifyResult ? providerErrorFromVerifyResult(verifyResult) : undefined;

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <h2 className="text-[15px] font-semibold">
        {connection.name
          ? `${t('settings.providers.edit')} ${connection.name}`
          : t('settings.providers.add')}
      </h2>

      {/* Classified by interface type, not vendor: pick the wire protocol,
          then enter the endpoint domain + key. */}
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="conn-kind">{t('settings.providers.kind')}</FieldLabel>
          <Select
            value={conn.kind}
            onValueChange={(v) => setConn({ ...conn, kind: v as Connection['kind'] })}
          >
            <SelectTrigger id="conn-kind" className="w-full">
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
          <FieldLabel htmlFor="conn-name">{t('settings.providers.name')}</FieldLabel>
          <Input
            id="conn-name"
            value={conn.name}
            onChange={(e) => setConn({ ...conn, name: e.target.value })}
            placeholder={t('settings.providers.namePlaceholder')}
          />
        </Field>

        <Field data-invalid={Boolean(fieldErrors.baseUrl)}>
          <FieldLabel htmlFor="conn-url">Base URL</FieldLabel>
          <Input
            id="conn-url"
            className="font-mono"
            value={conn.baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(e) => {
              setConn({ ...conn, baseUrl: e.target.value });
              setFieldErrors((current) => ({ ...current, baseUrl: undefined }));
            }}
            aria-invalid={Boolean(fieldErrors.baseUrl)}
          />
          {urlHint && <FieldDescription>{urlHint}</FieldDescription>}
          {fieldErrors.baseUrl && <FieldError>{fieldErrors.baseUrl}</FieldError>}
        </Field>

        <Field>
          <FieldLabel htmlFor="conn-keys">{t('settings.providers.keys')}</FieldLabel>
          <Textarea
            id="conn-keys"
            className="font-mono"
            rows={2}
            value={keysText}
            onChange={(e) => {
              keysDirty.current = true;
              setKeysText(e.target.value);
            }}
            placeholder="sk-…"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="conn-models">{t('settings.providers.models')}</FieldLabel>
          <Textarea
            id="conn-models"
            className="font-mono"
            rows={2}
            value={modelsText}
            onChange={(e) => setModelsText(e.target.value)}
            placeholder={t('settings.providers.modelsPlaceholder')}
          />
        </Field>

        <Collapsible>
          <CollapsibleTrigger className="text-[12px] text-muted-foreground hover:text-foreground data-[state=open]:text-foreground">
            {t('settings.providers.quirks')}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <FieldSet className="mt-2 gap-3 rounded-md border border-border p-3">
              <FieldLegend variant="label" className="sr-only">
                {t('settings.providers.quirks')}
              </FieldLegend>
              <FieldGroup className="gap-3">
                {(
                  [
                    ['noStreamOptions', t('settings.providers.quirk.noStreamOptions')],
                    ['thinkTagReasoning', t('settings.providers.quirk.thinkTagReasoning')],
                    ['noParallelToolCalls', t('settings.providers.quirk.noParallelToolCalls')],
                    ['noSystemRole', t('settings.providers.quirk.noSystemRole')],
                  ] as [keyof QuirkFlags, string][]
                ).map(([key, label]) => (
                  <Field key={key} orientation="horizontal">
                    <Checkbox
                      id={`quirk-${conn.id}-${key}`}
                      checked={Boolean(conn.quirks?.[key])}
                      onCheckedChange={(on) =>
                        setConn({
                          ...conn,
                          quirks: { ...conn.quirks, [key]: on === true || undefined },
                        })
                      }
                    />
                    <FieldLabel htmlFor={`quirk-${conn.id}-${key}`}>{label}</FieldLabel>
                  </Field>
                ))}
                <Field orientation="responsive">
                  <FieldLabel htmlFor="conn-max-tokens-field">
                    {t('settings.providers.maxTokensField')}
                  </FieldLabel>
                  <Select
                    value={conn.quirks?.maxTokensField ?? 'max_tokens'}
                    onValueChange={(v) =>
                      setConn({
                        ...conn,
                        quirks: {
                          ...conn.quirks,
                          maxTokensField: v as QuirkFlags['maxTokensField'],
                        },
                      })
                    }
                  >
                    <SelectTrigger
                      id="conn-max-tokens-field"
                      size="sm"
                      className="font-mono text-[12px]"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="max_tokens">max_tokens</SelectItem>
                        <SelectItem value="max_completion_tokens">max_completion_tokens</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </FieldGroup>
            </FieldSet>
          </CollapsibleContent>
        </Collapsible>

        <Collapsible>
          <CollapsibleTrigger className="text-[12px] text-muted-foreground hover:text-foreground data-[state=open]:text-foreground">
            {t('settings.providers.advanced')}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <FieldGroup className="mt-2 gap-3 rounded-md border border-border p-3">
              <Field data-invalid={Boolean(fieldErrors.headers)}>
                <FieldLabel htmlFor="conn-headers">{t('settings.providers.headers')}</FieldLabel>
                <Textarea
                  id="conn-headers"
                  className="font-mono text-[12px]"
                  rows={3}
                  value={headersText}
                  onChange={(event) => {
                    headersDirty.current = true;
                    setHeadersText(event.target.value);
                    setFieldErrors((current) => ({ ...current, headers: undefined }));
                  }}
                  aria-invalid={Boolean(fieldErrors.headers)}
                  placeholder="X-Organization: org-id"
                />
                {fieldErrors.headers && <FieldError>{fieldErrors.headers}</FieldError>}
              </Field>
              <Field data-invalid={Boolean(fieldErrors.modelConfig)}>
                <FieldLabel htmlFor="conn-model-config">
                  {t('settings.providers.modelConfig')}
                </FieldLabel>
                <Textarea
                  id="conn-model-config"
                  className="font-mono text-[11px]"
                  rows={7}
                  value={modelConfigText}
                  onChange={(event) => {
                    setModelConfigText(event.target.value);
                    setFieldErrors((current) => ({ ...current, modelConfig: undefined }));
                  }}
                  aria-invalid={Boolean(fieldErrors.modelConfig)}
                  placeholder={
                    '[{\n  "id": "model-id",\n  "capabilities": { "toolUse": true, "vision": true, "reasoning": false, "maxContext": 128000 },\n  "pricing": { "input": 1, "output": 4 }\n}]'
                  }
                />
                {fieldErrors.modelConfig && <FieldError>{fieldErrors.modelConfig}</FieldError>}
              </Field>
            </FieldGroup>
          </CollapsibleContent>
        </Collapsible>

        {verifyResult && (
          <>
            {verifyError ? (
              <ProviderErrorNotice
                error={verifyError}
                status={<VerifyStatus result={verifyResult} />}
              />
            ) : (
              <Alert variant="success">
                <AlertDescription>
                  <VerifyStatus result={verifyResult} />
                </AlertDescription>
              </Alert>
            )}
            {verifyResult.models && verifyResult.models.length > 0 && (
              <div className="flex flex-col gap-1.5 text-[13px]">
                <div className="text-muted-foreground">
                  {t('settings.providers.discovered', { n: verifyResult.models.length })}
                </div>
                <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
                  {verifyResult.models.map((m) => (
                    <Badge key={m} variant="secondary" className="font-mono">
                      {m}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
        {formError && (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}
      </FieldGroup>

      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void verify()}
          disabled={verifying}
          aria-busy={verifying}
        >
          {verifying ? t('settings.providers.verifying') : t('settings.providers.verify')}
        </Button>
        <Button
          size="sm"
          className="ml-auto px-4"
          onClick={() => {
            try {
              setFormError(null);
              setFieldErrors({});
              onSave(built());
            } catch (error) {
              handleConfigurationError(error);
            }
          }}
        >
          {t('app.save')}
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t('app.cancel')}
        </Button>
      </div>
    </div>
  );
}

function parseModelConfigs(value: unknown): NonNullable<Connection['models']> {
  if (!Array.isArray(value)) throw new Error(t('settings.providers.invalidModelArray'));
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null)
      throw new Error(t('settings.providers.invalidModelObject', { index: index + 1 }));
    const model = entry as Record<string, unknown>;
    const capabilities = model.capabilities as Record<string, unknown> | undefined;
    if (
      typeof model.id !== 'string' ||
      !model.id ||
      !capabilities ||
      typeof capabilities.toolUse !== 'boolean' ||
      typeof capabilities.vision !== 'boolean'
    ) {
      throw new Error(t('settings.providers.invalidModelCapabilities', { index: index + 1 }));
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
      throw new Error(t('settings.providers.invalidPricing', { index: index + 1 }));
    }
    return entry as NonNullable<Connection['models']>[number];
  });
}
