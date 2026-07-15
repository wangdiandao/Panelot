import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ChevronDown,
  ExternalLink,
  FileText,
  Globe2,
  Package,
  ShieldAlert,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { PanelotDB } from '../../db/schema';
import type { PluginAssetRecord, PluginRecord } from '../../db/types';
import { hostPermissionBroker } from '../../permissions/hostPermissionBroker';
import { PluginManager, pluginDownloadPermissionOrigins } from '../../plugins/manager';
import type { PluginInstallPlan, PluginInstallWarning } from '../../plugins/manifest';
import { FilePickerButton } from '../components/FilePickerButton';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty';
import { Input } from '../components/ui/input';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import { Field, FieldError, FieldGroup, FieldLabel } from '../components/ui/field';
import { ScrollArea } from '../components/ui/scroll-area';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '../components/ui/item';
import { Separator } from '../components/ui/separator';
import { Switch } from '../components/ui/switch';
import { t } from '../i18n';

const db = new PanelotDB();

const WARNING_KEYS: Record<PluginInstallWarning, string> = {
  'prompt-assets-disabled': 'settings.plugins.security.promptAssetsDisabled',
  'upgrade-disables-plugin': 'settings.plugins.security.upgradeDisabled',
  'opaque-assets': 'settings.plugins.security.opaqueAssets',
};

export function PluginsPage() {
  const manager = useMemo(() => new PluginManager(db), []);
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [assets, setAssets] = useState<PluginAssetRecord[]>([]);
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PluginInstallPlan | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const [nextPlugins, nextAssets] = await Promise.all([
      db.plugins.orderBy('name').toArray(),
      db.pluginAssets.orderBy('createdAt').toArray(),
    ]);
    setPlugins(nextPlugins);
    setAssets(nextAssets);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const analyzeZip = async (file: File) => {
    setBusy(true);
    try {
      setPlan(await manager.analyzeZip(await file.arrayBuffer(), { kind: 'zip', ref: file.name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const analyzeUrl = async () => {
    setBusy(true);
    try {
      const parsed = new URL(url);
      const granted = await hostPermissionBroker.requestAll(
        pluginDownloadPermissionOrigins(parsed),
      );
      if (!granted) throw new Error(t('settings.plugins.permissionDenied'));
      setPlan(await manager.analyzeUrl(parsed.href));
      setUrlError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUrlError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const confirmInstall = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      await manager.commit(plan, { confirmed: true });
      if (plan.source.kind === 'github') setUrl('');
      setPlan(null);
      await refresh();
      toast.success(t('settings.plugins.installed'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <div>
        <h2 className="text-[15px] font-semibold">{t('settings.section.plugins')}</h2>
        <p className="mt-1 text-[11px] text-faint-foreground">{t('settings.plugins.limit')}</p>
      </div>

      <FieldGroup className="gap-2 rounded-xl border border-border/40 p-3">
        <Field orientation="responsive" data-invalid={Boolean(urlError)}>
          <FieldLabel htmlFor="plugin-url" className="sr-only">
            {t('settings.plugins.urlLabel')}
          </FieldLabel>
          <Input
            id="plugin-url"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setUrlError(null);
            }}
            aria-invalid={Boolean(urlError)}
            placeholder="https://github.com/owner/repo/archive/refs/heads/main.zip"
            aria-label={t('settings.plugins.urlLabel')}
          />
          <Button
            size="sm"
            disabled={busy || !url.trim()}
            aria-busy={busy}
            onClick={() => void analyzeUrl()}
          >
            <ExternalLink data-icon="inline-start" />
            {busy ? t('settings.plugins.analyzing') : t('settings.plugins.analyzeGithub')}
          </Button>
          {urlError && <FieldError>{urlError}</FieldError>}
        </Field>
        <Field>
          <FilePickerButton
            id="plugin-zip-import"
            label={t('settings.plugins.chooseZipLabel')}
            accept=".zip,application/zip"
            disabled={busy}
            onFile={(file) => void analyzeZip(file)}
          >
            <Archive data-icon="inline-start" /> {t('settings.plugins.chooseZip')}
          </FilePickerButton>
        </Field>
      </FieldGroup>

      {plugins.length === 0 ? (
        <Empty className="border border-dashed p-6 md:p-6">
          <EmptyHeader>
            <EmptyTitle className="text-base">{t('settings.plugins.emptyTitle')}</EmptyTitle>
            <EmptyDescription>{t('settings.plugins.emptyHint')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-2">
          {plugins.map((plugin) => {
            const owned = assets.filter((asset) => asset.pluginId === plugin.id);
            return (
              <Item key={plugin.id} variant="outline">
                <ItemMedia variant="icon">
                  <Package />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle>
                    {plugin.name}
                    <Badge variant="secondary">{plugin.version}</Badge>
                    <Badge variant="outline">{plugin.id}</Badge>
                  </ItemTitle>
                  {plugin.description && <ItemDescription>{plugin.description}</ItemDescription>}
                </ItemContent>
                <ItemActions>
                  <Switch
                    checked={plugin.enabled}
                    aria-label={t(
                      plugin.enabled ? 'settings.plugins.disable' : 'settings.plugins.enable',
                      { name: plugin.name },
                    )}
                    onCheckedChange={(enabled) =>
                      void manager.setEnabled(plugin.id, enabled).then(refresh)
                    }
                  />
                  <Button
                    variant="destructive"
                    size="icon-sm"
                    aria-label={t('settings.plugins.uninstall', { name: plugin.name })}
                    onClick={() => void manager.uninstall(plugin.id).then(refresh)}
                  >
                    <Trash2 data-icon="inline-start" />
                  </Button>
                </ItemActions>
                <ItemFooter>
                  <Collapsible className="group/collapsible w-full text-xs text-muted-foreground">
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="xs">
                        {t('settings.plugins.manifest', { n: owned.length })}
                        <ChevronDown
                          data-icon="inline-start"
                          className="transition-transform group-data-[state=open]/collapsible:rotate-180"
                        />
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
                      <ul className="mt-1 flex flex-col gap-0.5 pl-4 font-mono">
                        {owned.map((asset) => (
                          <li key={asset.id}>
                            {asset.kind}: {asset.path}
                          </li>
                        ))}
                      </ul>
                    </CollapsibleContent>
                  </Collapsible>
                </ItemFooter>
              </Item>
            );
          })}
        </ItemGroup>
      )}

      <Dialog
        open={plan !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPlan(null);
        }}
      >
        {plan && (
          <DialogContent
            className="max-h-[min(90vh,52rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-2xl"
            showCloseButton={!busy}
            onEscapeKeyDown={(event) => {
              if (busy) event.preventDefault();
            }}
            onInteractOutside={(event) => event.preventDefault()}
          >
            <DialogHeader className="p-6 pb-4">
              <div className="flex flex-wrap items-center gap-2 pr-6">
                <DialogTitle>
                  {t(
                    plan.operation === 'upgrade'
                      ? 'settings.plugins.preview.upgradeTitle'
                      : 'settings.plugins.preview.installTitle',
                  )}
                </DialogTitle>
                <Badge variant="outline">{t('settings.plugins.preview.disabled')}</Badge>
              </div>
              <DialogDescription>{t('settings.plugins.preview.description')}</DialogDescription>
            </DialogHeader>

            <ScrollArea className="min-h-0 px-6 pb-6">
              <div className="flex flex-col gap-4 pr-3">
                <Alert>
                  <ShieldAlert />
                  <AlertTitle>{t('settings.plugins.security.title')}</AlertTitle>
                  <AlertDescription>
                    <p>{t('settings.plugins.security.body')}</p>
                    {plan.warnings.length > 0 && (
                      <ul className="list-disc pl-4">
                        {plan.warnings.map((warning) => (
                          <li key={warning}>{t(WARNING_KEYS[warning])}</li>
                        ))}
                      </ul>
                    )}
                  </AlertDescription>
                </Alert>

                <section aria-labelledby="plugin-preview-package" className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 id="plugin-preview-package" className="font-medium">
                      {plan.manifest.name}
                    </h3>
                    <Badge variant="secondary">{plan.manifest.version}</Badge>
                    <Badge variant="outline">{plan.manifest.id}</Badge>
                  </div>
                  {plan.manifest.description && (
                    <p className="text-sm text-muted-foreground">{plan.manifest.description}</p>
                  )}
                  {plan.existing && (
                    <p className="text-sm text-muted-foreground">
                      {t('settings.plugins.preview.existing', { version: plan.existing.version })}
                    </p>
                  )}
                  <dl className="grid gap-2 rounded-lg border bg-muted/30 p-3 text-xs">
                    <div className="grid gap-1">
                      <dt className="font-medium">{t('settings.plugins.preview.source')}</dt>
                      <dd className="break-all text-muted-foreground">{plan.source.label}</dd>
                    </div>
                    {plan.source.resolvedUrl && plan.source.resolvedUrl !== plan.source.label && (
                      <div className="grid gap-1">
                        <dt className="font-medium">
                          {t('settings.plugins.preview.resolvedSource')}
                        </dt>
                        <dd className="break-all text-muted-foreground">
                          {plan.source.resolvedUrl}
                        </dd>
                      </div>
                    )}
                    <div className="grid gap-1">
                      <dt className="font-medium">{t('settings.plugins.preview.digest')}</dt>
                      <dd className="break-all font-mono text-muted-foreground">{plan.digest}</dd>
                    </div>
                    <div className="text-muted-foreground">
                      {t('settings.plugins.preview.expires', {
                        time: new Date(plan.expiresAt).toLocaleTimeString(),
                      })}
                    </div>
                  </dl>
                </section>

                <Separator />

                <PreviewSection
                  id="plugin-preview-assets"
                  icon={<FileText />}
                  title={t('settings.plugins.preview.assets', { n: plan.assets.length })}
                >
                  <ul className="flex flex-col gap-2">
                    {plan.assets.map((asset) => (
                      <li key={asset.path} className="flex min-w-0 items-start gap-2 text-sm">
                        <Badge variant="outline" className="mt-0.5">
                          {asset.kind}
                        </Badge>
                        <span className="min-w-0 break-all font-mono text-xs">{asset.path}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {t('settings.plugins.preview.bytes', {
                            n: asset.bytes.toLocaleString(),
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                </PreviewSection>

                {plan.skills.length > 0 && (
                  <PreviewSection
                    id="plugin-preview-skills"
                    icon={<Sparkles />}
                    title={t('settings.plugins.preview.skills', { n: plan.skills.length })}
                  >
                    <ul className="flex flex-col gap-2">
                      {plan.skills.map((skill) => (
                        <li key={skill.path} className="rounded-lg border p-3 text-sm">
                          <div className="font-medium">{skill.name}</div>
                          <div className="text-muted-foreground">{skill.description}</div>
                          <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
                            {skill.path}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </PreviewSection>
                )}

                {plan.presets.length > 0 && (
                  <PreviewSection
                    id="plugin-preview-presets"
                    icon={<Sparkles />}
                    title={t('settings.plugins.preview.presets', { n: plan.presets.length })}
                  >
                    <ul className="flex flex-col gap-2">
                      {plan.presets.map((preset) => (
                        <li
                          key={`${preset.path}:${preset.id}`}
                          className="rounded-lg border p-3 text-sm"
                        >
                          <div className="font-medium">{preset.name}</div>
                          <div className="text-muted-foreground">
                            {t('settings.plugins.preview.model', { model: preset.model })}
                          </div>
                          {preset.systemPromptSummary && (
                            <div className="mt-1 text-muted-foreground">
                              {t('settings.plugins.preview.promptSummary', {
                                summary: preset.systemPromptSummary,
                              })}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </PreviewSection>
                )}

                {plan.siteInstructions.length > 0 && (
                  <PreviewSection
                    id="plugin-preview-sites"
                    icon={<Globe2 />}
                    title={t('settings.plugins.preview.sites', { n: plan.siteInstructions.length })}
                  >
                    <ul className="flex flex-col gap-2">
                      {plan.siteInstructions.map((instruction) => (
                        <li
                          key={`${instruction.path}:${instruction.pattern}`}
                          className="rounded-lg border p-3 text-sm"
                        >
                          <Badge variant="secondary">{instruction.pattern}</Badge>
                          <p className="mt-2 text-muted-foreground">
                            {instruction.instructionSummary}
                          </p>
                          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                            {instruction.path}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </PreviewSection>
                )}
              </div>
            </ScrollArea>

            <DialogFooter className="border-t bg-background px-6 py-4">
              <DialogClose asChild>
                <Button variant="outline" disabled={busy}>
                  {t('settings.plugins.cancel')}
                </Button>
              </DialogClose>
              <Button disabled={busy} aria-busy={busy} onClick={() => void confirmInstall()}>
                {t(
                  plan.operation === 'upgrade'
                    ? 'settings.plugins.confirmUpgrade'
                    : 'settings.plugins.confirmInstall',
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

function PreviewSection({
  id,
  icon,
  title,
  children,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className="flex items-center gap-2 text-sm font-medium [&_svg]:size-4">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}
