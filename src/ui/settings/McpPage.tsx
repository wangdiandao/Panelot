/**
 * MCP settings (docs/07 §5, docs/09 §3.4): server cards with state indicators,
 * paste-JSON import, add form, OAuth trigger. The manager lives in the
 * background SW; this page talks to storage + messages the SW for connect.
 * Built on shadcn/ui primitives; delete confirm uses AlertDialog.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { Textarea } from '../components/ui/textarea';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../components/ui/field';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemTitle,
} from '../components/ui/item';
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
  parseMcpJson,
  type McpOAuthPermissionRequired,
  type McpServerConfig,
} from '../../mcp/types';
import { listMcpServers, saveMcpServers } from '../../mcp/store';
import { hostPermissionBroker } from '../../permissions/hostPermissionBroker';
import { t } from '../i18n';

export function McpPage() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [importText, setImportText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleting, setDeleting] = useState<McpServerConfig | null>(null);
  const [descriptions, setDescriptions] = useState<Record<string, McpDescription>>({});
  const [permissionPlans, setPermissionPlans] = useState<
    Record<string, McpOAuthPermissionRequired>
  >({});

  const loadDescription = useCallback(async (id: string, connect = false) => {
    const response = (await chrome.runtime.sendMessage({
      type: connect ? 'panelot.mcpConnect' : 'panelot.mcpStatus',
      id,
    })) as McpResponse;
    if (response.description) {
      setDescriptions((current) => ({ ...current, [id]: response.description! }));
    }
    if (response.permissionRequired) {
      setPermissionPlans((current) => ({ ...current, [id]: response.permissionRequired! }));
    } else if (response.ok && connect) {
      setPermissionPlans((current) => withoutKey(current, id));
    }
    if (!response.ok && response.error) toast.error(response.error);
  }, []);

  const refresh = useCallback(
    () =>
      listMcpServers().then((list) => {
        setServers(list);
        for (const server of list) void loadDescription(server.id);
      }),
    [loadDescription],
  );
  useEffect(() => void refresh(), [refresh]);

  const save = async (list: McpServerConfig[]) => {
    setServers(list);
    await saveMcpServers(list);
  };

  const doImport = async () => {
    try {
      const parsed = parseMcpJson(importText);
      const added: McpServerConfig[] = parsed.map((p) => ({
        ...p,
        id: crypto.randomUUID(),
        enabled: true,
        disabledTools: [],
        connectOnStartup: false,
      }));
      for (const server of added) {
        const granted = await hostPermissionBroker.request(server.url);
        if (!granted) throw new Error(t('settings.mcp.permissionDenied', { url: server.url }));
      }
      await save([...servers, ...added]);
      setImportText('');
      setImportOpen(false);
      setError(null);
      toast.success(t('settings.mcp.added', { n: added.length }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const requestHost = async (url: string): Promise<boolean> => {
    try {
      return await hostPermissionBroker.request(url);
    } catch {
      return false;
    }
  };

  const runOAuth = async (server: McpServerConfig, plan?: McpOAuthPermissionRequired) => {
    const granted = plan
      ? await hostPermissionBroker.requestAll(plan.origins)
      : await requestHost(server.url);
    if (!granted) {
      toast.error(
        t('settings.mcp.permissionDenied', { url: plan?.origins.join(', ') ?? server.url }),
      );
      return;
    }
    const response = (await chrome.runtime.sendMessage({
      type: 'panelot.mcpOauth',
      id: server.id,
      permissionApproval: plan ? { stage: plan.stage, planDigest: plan.planDigest } : undefined,
    })) as McpResponse;
    if (response.permissionRequired) {
      setPermissionPlans((current) => ({
        ...current,
        [server.id]: response.permissionRequired!,
      }));
      return;
    }
    if (!response.ok) {
      toast.error(response.error ?? t('settings.mcp.oauthFailed'));
      return;
    }
    setPermissionPlans((current) => withoutKey(current, server.id));
    if (response.description) {
      setDescriptions((current) => ({ ...current, [server.id]: response.description! }));
    } else {
      await loadDescription(server.id);
    }
    toast.success(t('settings.mcp.oauthComplete'));
  };

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <div className="flex items-center">
        <h2 className="text-[15px] font-semibold">{t('settings.section.mcp')}</h2>
        <Button size="sm" className="ml-auto" onClick={() => setImportOpen((v) => !v)}>
          {t('settings.mcp.importJson')}
        </Button>
      </div>

      <Collapsible open={importOpen} onOpenChange={setImportOpen}>
        <CollapsibleTrigger className="sr-only">
          {t('settings.mcp.importConfig')}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <FieldGroup className="gap-2 rounded-lg border border-border p-3">
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="mcp-import-json">{t('settings.mcp.importConfig')}</FieldLabel>
              <Textarea
                id="mcp-import-json"
                value={importText}
                onChange={(e) => {
                  setImportText(e.target.value);
                  setError(null);
                }}
                aria-invalid={Boolean(error)}
                rows={6}
                placeholder={
                  '{\n  "mcpServers": {\n    "github": { "url": "https://…/mcp", "headers": { "Authorization": "Bearer …" } }\n  }\n}'
                }
                className="font-mono text-[12px]"
              />
              <FieldDescription>{t('settings.mcp.compatHint')}</FieldDescription>
              {error && <FieldError>{error}</FieldError>}
            </Field>
            <Button variant="outline" size="sm" onClick={() => void doImport()}>
              {t('settings.mcp.parseAdd')}
            </Button>
          </FieldGroup>
        </CollapsibleContent>
      </Collapsible>

      {servers.length === 0 ? (
        <Empty className="border border-dashed p-6 md:p-6">
          <EmptyHeader>
            <EmptyTitle className="text-base">{t('settings.mcp.emptyTitle')}</EmptyTitle>
            <EmptyDescription>{t('settings.mcp.emptyHint')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-2">
          {servers.map((s) => {
            const description = descriptions[s.id];
            const permissionPlan = permissionPlans[s.id];
            return (
              <Item key={s.id} variant="outline">
                <ItemContent>
                  <ItemTitle>
                    <Switch
                      checked={s.enabled}
                      onCheckedChange={(on) =>
                        void save(
                          servers.map((x) => (x.id === s.id ? { ...x, enabled: on } : x)),
                        ).then(() => refresh())
                      }
                      aria-label={s.name}
                    />
                    {s.name}
                    <Badge
                      variant={
                        description?.state.status === 'error'
                          ? 'destructive'
                          : description?.state.status === 'ready'
                            ? 'default'
                            : 'secondary'
                      }
                    >
                      {t(`settings.mcp.status.${description?.state.status ?? 'disconnected'}`)}
                    </Badge>
                  </ItemTitle>
                  <ItemDescription className="font-mono">
                    {s.url} · {t(`settings.mcp.auth.${s.auth.kind}`)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void requestHost(s.url).then((granted) => {
                        if (granted) return loadDescription(s.id, true);
                        toast.error(t('settings.mcp.permissionDenied', { url: s.url }));
                      })
                    }
                    disabled={!s.enabled || description?.state.status === 'connecting'}
                  >
                    {description?.state.status === 'ready'
                      ? t('settings.mcp.reconnect')
                      : t('settings.mcp.test')}
                  </Button>
                  {s.auth.kind === 'oauth' && (
                    <Button variant="outline" size="sm" onClick={() => void runOAuth(s)}>
                      {t('settings.mcp.authorize')}
                    </Button>
                  )}
                  <Button variant="destructive" size="sm" onClick={() => setDeleting(s)}>
                    {t('settings.mcp.delete')}
                  </Button>
                </ItemActions>
                {(description?.state.status === 'error' || permissionPlan || description) && (
                  <ItemFooter className="flex-col items-stretch">
                    {description?.state.status === 'error' && (
                      <Alert variant="destructive">
                        <AlertDescription>{description.state.reason}</AlertDescription>
                      </Alert>
                    )}
                    {permissionPlan && (
                      <Alert variant="warning">
                        <AlertTitle>{t('settings.mcp.permissionTitle')}</AlertTitle>
                        <AlertDescription className="break-all">
                          {t('settings.mcp.permissionResource', {
                            resource: permissionPlan.summary.resource,
                          })}
                          {permissionPlan.summary.issuer && (
                            <div className="break-all text-muted-foreground">
                              {t('settings.mcp.permissionIssuer', {
                                issuer: permissionPlan.summary.issuer,
                              })}
                            </div>
                          )}
                          {permissionPlan.originReasons.length > 0 ? (
                            <ul className="flex list-disc flex-col gap-1 pl-4">
                              {permissionPlan.originReasons.map(({ origin, reason }) => (
                                <li key={origin}>
                                  <code className="break-all">{origin}</code>
                                  <span className="text-muted-foreground"> — {reason}</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <div className="text-muted-foreground">
                              {t(
                                permissionPlan.reason === 'plan_expired'
                                  ? 'settings.mcp.permissionPlanExpired'
                                  : 'settings.mcp.permissionPlanChanged',
                              )}
                            </div>
                          )}
                        </AlertDescription>
                        <AlertAction placement="footer">
                          <Button size="sm" onClick={() => void runOAuth(s, permissionPlan)}>
                            {t('settings.mcp.permissionContinue')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setPermissionPlans((current) => withoutKey(current, s.id))
                            }
                          >
                            {t('app.cancel')}
                          </Button>
                        </AlertAction>
                      </Alert>
                    )}
                    {description && (
                      <Collapsible>
                        <CollapsibleTrigger className="mt-2 text-[11px] text-muted-foreground hover:text-foreground">
                          {t('settings.mcp.inventory', {
                            tools: description.tools.length,
                            prompts: description.promptCount,
                            resources: description.resourceCount,
                          })}
                        </CollapsibleTrigger>
                        <CollapsibleContent className="mt-1 pt-2">
                          <FieldGroup className="gap-1">
                            {description.tools.map((tool) => (
                              <Field key={tool.name} orientation="horizontal">
                                <Switch
                                  id={`mcp-tool-${s.id}-${tool.name}`}
                                  checked={!s.disabledTools.includes(tool.name)}
                                  aria-label={t('settings.mcp.enableTool', { name: tool.name })}
                                  onCheckedChange={(enabled) => {
                                    const disabledTools = enabled
                                      ? s.disabledTools.filter((name) => name !== tool.name)
                                      : [...new Set([...s.disabledTools, tool.name])];
                                    void save(
                                      servers.map((server) =>
                                        server.id === s.id ? { ...server, disabledTools } : server,
                                      ),
                                    ).then(() => refresh());
                                  }}
                                />
                                <FieldContent>
                                  <FieldLabel
                                    htmlFor={`mcp-tool-${s.id}-${tool.name}`}
                                    className="font-mono"
                                  >
                                    {tool.name}
                                  </FieldLabel>
                                  {tool.description && (
                                    <FieldDescription>{tool.description}</FieldDescription>
                                  )}
                                </FieldContent>
                              </Field>
                            ))}
                            {description.tools.length === 0 && (
                              <FieldDescription>
                                {t('settings.mcp.toolsAfterConnect')}
                              </FieldDescription>
                            )}
                          </FieldGroup>
                        </CollapsibleContent>
                      </Collapsible>
                    )}
                  </ItemFooter>
                )}
              </Item>
            );
          })}
        </ItemGroup>
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings.mcp.deleteTitle', { name: deleting?.name || '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('settings.mcp.deleteHint')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('app.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) {
                  void save(servers.filter((x) => x.id !== deleting.id));
                  toast.success(t('settings.mcp.deleted'));
                }
                setDeleting(null);
              }}
            >
              {t('settings.mcp.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface McpDescription {
  state:
    | { status: 'disconnected' | 'connecting' }
    | { status: 'ready'; toolCount: number }
    | { status: 'error'; reason: string };
  tools: { name: string; description?: string; disabled: boolean }[];
  promptCount: number;
  resourceCount: number;
}

interface McpResponse {
  ok: boolean;
  error?: string;
  description?: McpDescription;
  permissionRequired?: McpOAuthPermissionRequired;
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}
