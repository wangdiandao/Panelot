import { useEffect, useState } from 'react';
import { Bot, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PanelotDB } from '../../db/schema';
import type { SkillRecord } from '../../db/types';
import type { Connection, GenParams, ModelPreset } from '../../providers/types';
import { SettingsStore, type GlobalSettings } from '../../settings/store';
import { normalizeModelPreset, type LegacyModelPreset } from '../../settings/presets';
import { useStorageValue } from '../useStorageValue';
import { listEnabledPluginPresets, type PluginPresetAsset } from '../../plugins/assets';
import { ModelSelector } from '../components/ModelSelector';
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
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Alert, AlertDescription } from '../components/ui/alert';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import { Checkbox } from '../components/ui/checkbox';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../components/ui/empty';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '../components/ui/field';
import { Input } from '../components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Separator } from '../components/ui/separator';
import { Textarea } from '../components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import { t } from '../i18n';

const db = new PanelotDB();
const TOOL_LEVELS = ['L0', 'L1', 'L2', 'mcp'] as const;

function createPreset(): ModelPreset {
  return {
    id: crypto.randomUUID(),
    name: '',
    base: { connectionId: '', modelId: '' },
    enabledToolLevels: [...TOOL_LEVELS],
    defaultPermissionPolicy: 'untrusted',
    skills: [],
    promptVersion: 'kernel',
  };
}

function optionalNumber(value: string): number | undefined {
  return value.trim() ? Number(value) : undefined;
}

export function presetPermissionPolicyLabel(policy: string): string {
  return t(`settings.permissions.policy.${policy}.label`);
}

export function PresetsPage() {
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [pluginPresets, setPluginPresets] = useState<PluginPresetAsset[]>([]);
  const [editing, setEditing] = useState<ModelPreset | null>(null);
  const [deleting, setDeleting] = useState<ModelPreset | null>(null);
  const connections = (useStorageValue<Connection[] | null>('connections', null) ?? []).filter(
    (connection) => connection.enabled,
  );
  const global = useStorageValue<GlobalSettings | null>('global_settings', null) ?? {};
  const presets = (useStorageValue<LegacyModelPreset[] | null>('model_presets', null) ?? []).map(
    normalizeModelPreset,
  );

  useEffect(() => {
    void Promise.all([
      db.skills.where('enabled').equals(1).toArray(),
      listEnabledPluginPresets(db),
    ]).then(([enabledSkills, installedPresets]) => {
      setSkills(enabledSkills);
      setPluginPresets(installedPresets);
    });
  }, []);

  const updateTaskModel = async (choice: { connectionId: string; modelId: string } | null) => {
    await SettingsStore.global.patch({ taskModel: choice ?? undefined });
    toast.success(
      choice
        ? t('settings.presets.taskModelSet', { model: choice.modelId })
        : t('settings.presets.taskModelDefault'),
    );
  };

  if (editing) {
    return (
      <PresetForm
        preset={editing}
        connections={connections}
        skills={skills}
        onCancel={() => setEditing(null)}
        onSave={async (candidate) => {
          await SettingsStore.presets.upsert(candidate);
          setEditing(null);
          toast.success(t('settings.presets.saved'));
        }}
      />
    );
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-col items-start gap-3 sm:flex-row">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{t('settings.presets.title')}</h2>
          <p className="mt-1 text-[12px] text-muted-foreground">{t('settings.presets.summary')}</p>
        </div>
        <Button className="sm:ml-auto" size="sm" onClick={() => setEditing(createPreset())}>
          <Plus data-icon="inline-start" />
          {t('settings.presets.new')}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.presets.taskModel')}</CardTitle>
          <CardDescription>{t('settings.presets.taskModelHint')}</CardDescription>
          <CardAction>
            <ModelSelector
              value={global.taskModel ?? null}
              onSelect={(choice) =>
                void updateTaskModel(
                  choice ? { connectionId: choice.connectionId, modelId: choice.modelId } : null,
                )
              }
            />
          </CardAction>
        </CardHeader>
      </Card>

      {presets.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Bot />
            </EmptyMedia>
            <EmptyTitle>{t('settings.presets.emptyTitle')}</EmptyTitle>
            <EmptyDescription>{t('settings.presets.emptyHint')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={() => setEditing(createPreset())}>
              <Plus data-icon="inline-start" />
              {t('settings.presets.new')}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {presets.map((preset) => (
            <Card key={preset.id}>
              <CardHeader>
                <CardTitle>
                  {preset.icon ? `${preset.icon} ` : ''}
                  {preset.name}
                </CardTitle>
                <CardDescription>
                  {connections.find((connection) => connection.id === preset.base.connectionId)
                    ?.name ?? preset.base.connectionId}
                  {' · '}
                  {preset.base.modelId}
                </CardDescription>
                <CardAction>
                  <Button variant="outline" size="sm" onClick={() => setEditing(preset)}>
                    {t('settings.presets.edit')}
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>{(preset.enabledToolLevels ?? TOOL_LEVELS).join(', ')}</span>
                <Separator orientation="vertical" className="h-4" />
                <span>
                  {presetPermissionPolicyLabel(preset.defaultPermissionPolicy ?? 'untrusted')}
                </span>
              </CardContent>
              <CardFooter>
                <Button variant="destructive" size="sm" onClick={() => setDeleting(preset)}>
                  <Trash2 data-icon="inline-start" />
                  {t('settings.presets.delete')}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {pluginPresets.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">{t('settings.presets.pluginTitle')}</h3>
          {pluginPresets.map((asset) => (
            <Card key={`${asset.assetId}:${asset.preset.id}`}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  {asset.preset.name}
                  <Badge variant="outline">{asset.pluginId}</Badge>
                </CardTitle>
                <CardDescription>
                  {asset.preset.base.connectionId} · {asset.preset.base.modelId} ·{' '}
                  {presetPermissionPolicyLabel(asset.preset.defaultPermissionPolicy ?? 'untrusted')}
                </CardDescription>
                <CardAction>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setEditing({
                        ...asset.preset,
                        id: crypto.randomUUID(),
                        name: t('settings.presets.copySuffix', { name: asset.preset.name }),
                      })
                    }
                  >
                    {t('settings.presets.copyEdit')}
                  </Button>
                </CardAction>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.presets.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.presets.deleteHint')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('app.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) void SettingsStore.presets.remove(deleting.id);
                setDeleting(null);
              }}
            >
              {t('settings.presets.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PresetForm({
  preset: initialPreset,
  connections,
  skills,
  onSave,
  onCancel,
}: {
  preset: ModelPreset;
  connections: Connection[];
  skills: SkillRecord[];
  onSave: (preset: ModelPreset) => Promise<void>;
  onCancel: () => void;
}) {
  const [preset, setPreset] = useState(initialPreset);
  const [error, setError] = useState<string | null>(null);
  const updateParams = (patch: Partial<GenParams>) =>
    setPreset({ ...preset, params: { ...preset.params, ...patch } });

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>
          {initialPreset.name ? t('settings.presets.editTitle') : t('settings.presets.createTitle')}
        </CardTitle>
        <CardDescription>{t('settings.presets.formHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
            <Field data-invalid={Boolean(error && !preset.name.trim())}>
              <FieldLabel htmlFor="preset-name">{t('settings.presets.name')}</FieldLabel>
              <Input
                id="preset-name"
                value={preset.name}
                aria-invalid={Boolean(error && !preset.name.trim())}
                onChange={(event) => setPreset({ ...preset, name: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="preset-icon">{t('settings.presets.icon')}</FieldLabel>
              <Input
                id="preset-icon"
                value={preset.icon ?? ''}
                onChange={(event) => setPreset({ ...preset, icon: event.target.value })}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="preset-connection">
                {t('settings.presets.connection')}
              </FieldLabel>
              <Select
                value={preset.base.connectionId || undefined}
                onValueChange={(connectionId) =>
                  setPreset({ ...preset, base: { ...preset.base, connectionId } })
                }
              >
                <SelectTrigger id="preset-connection" className="w-full">
                  <SelectValue placeholder={t('settings.presets.selectConnection')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {connections.map((connection) => (
                      <SelectItem key={connection.id} value={connection.id}>
                        {connection.name || connection.baseUrl}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="preset-model">{t('settings.presets.modelId')}</FieldLabel>
              <Input
                id="preset-model"
                value={preset.base.modelId}
                list="preset-model-options"
                onChange={(event) =>
                  setPreset({ ...preset, base: { ...preset.base, modelId: event.target.value } })
                }
              />
              <datalist id="preset-model-options">
                {(
                  connections.find((connection) => connection.id === preset.base.connectionId)
                    ?.models ?? []
                ).map((model) => (
                  <option key={model.id} value={model.id} />
                ))}
                {(
                  connections.find((connection) => connection.id === preset.base.connectionId)
                    ?.modelIds ?? []
                ).map((modelId) => (
                  <option key={modelId} value={modelId} />
                ))}
              </datalist>
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="preset-prompt">{t('settings.presets.systemPrompt')}</FieldLabel>
            <Textarea
              id="preset-prompt"
              rows={6}
              value={preset.systemPrompt ?? ''}
              onChange={(event) => setPreset({ ...preset, systemPrompt: event.target.value })}
            />
          </Field>

          <FieldSet>
            <FieldLegend variant="label">{t('settings.presets.parameters')}</FieldLegend>
            <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <NumberField
                id="preset-temperature"
                label="Temperature"
                value={preset.params?.temperature}
                min={0}
                max={2}
                step={0.1}
                onChange={(value) => updateParams({ temperature: value })}
              />
              <NumberField
                id="preset-top-p"
                label="Top P"
                value={preset.params?.topP}
                min={0}
                max={1}
                step={0.05}
                onChange={(value) => updateParams({ topP: value })}
              />
              <NumberField
                id="preset-max-tokens"
                label={t('settings.presets.maxTokens')}
                value={preset.params?.maxTokens}
                min={1}
                step={1}
                onChange={(value) => updateParams({ maxTokens: value })}
              />
              <Field>
                <FieldLabel htmlFor="preset-reasoning">
                  {t('settings.presets.reasoning')}
                </FieldLabel>
                <Select
                  value={preset.params?.reasoningEffort ?? 'unset'}
                  onValueChange={(value) =>
                    updateParams({
                      reasoningEffort:
                        value === 'unset'
                          ? undefined
                          : (value as NonNullable<GenParams['reasoningEffort']>),
                    })
                  }
                >
                  <SelectTrigger id="preset-reasoning" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="unset">{t('settings.presets.reasoning.unset')}</SelectItem>
                      <SelectItem value="low">{t('settings.presets.reasoning.low')}</SelectItem>
                      <SelectItem value="medium">
                        {t('settings.presets.reasoning.medium')}
                      </SelectItem>
                      <SelectItem value="high">{t('settings.presets.reasoning.high')}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
          </FieldSet>

          <Field>
            <FieldLabel htmlFor="preset-stop">{t('settings.presets.stop')}</FieldLabel>
            <Textarea
              id="preset-stop"
              rows={3}
              value={preset.params?.stopSequences?.join('\n') ?? ''}
              onChange={(event) => updateParams({ stopSequences: event.target.value.split('\n') })}
            />
          </Field>

          <FieldSet>
            <FieldLegend variant="label">{t('settings.presets.toolLevels')}</FieldLegend>
            <ToggleGroup
              type="multiple"
              variant="outline"
              value={preset.enabledToolLevels ?? []}
              onValueChange={(levels) =>
                setPreset({
                  ...preset,
                  enabledToolLevels: levels as ModelPreset['enabledToolLevels'],
                })
              }
              aria-label={t('settings.presets.toolLevels')}
            >
              {TOOL_LEVELS.map((level) => (
                <ToggleGroupItem key={level} value={level} aria-label={level}>
                  {level}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>{t('settings.presets.toolLevelsHint')}</FieldDescription>
          </FieldSet>

          <div className="grid grid-cols-1 gap-4">
            <EnumField
              id="preset-default-policy"
              label={t('settings.presets.defaultPolicy')}
              value={preset.defaultPermissionPolicy ?? 'untrusted'}
              values={['always', 'untrusted', 'auto']}
              getOptionLabel={presetPermissionPolicyLabel}
              onChange={(value) =>
                setPreset({
                  ...preset,
                  defaultPermissionPolicy: value as ModelPreset['defaultPermissionPolicy'],
                })
              }
            />
          </div>

          <FieldSet>
            <FieldLegend variant="label">{t('settings.presets.skills')}</FieldLegend>
            <FieldGroup className="gap-3">
              {skills.length === 0 && (
                <FieldDescription>{t('settings.presets.noSkills')}</FieldDescription>
              )}
              {skills.map((skill) => {
                const checked = preset.skills?.includes(skill.id) ?? false;
                return (
                  <Field key={skill.id} orientation="horizontal">
                    <Checkbox
                      id={`preset-skill-${skill.id}`}
                      checked={checked}
                      onCheckedChange={(value) =>
                        setPreset({
                          ...preset,
                          skills:
                            value === true
                              ? [...new Set([...(preset.skills ?? []), skill.id])]
                              : (preset.skills ?? []).filter((id) => id !== skill.id),
                        })
                      }
                    />
                    <FieldContent>
                      <FieldLabel htmlFor={`preset-skill-${skill.id}`}>{skill.name}</FieldLabel>
                      <FieldDescription>
                        {typeof (skill.frontmatter as { description?: unknown }).description ===
                        'string'
                          ? (skill.frontmatter as { description: string }).description
                          : skill.source}
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                );
              })}
            </FieldGroup>
          </FieldSet>

          <Field>
            <FieldLabel htmlFor="preset-prompt-version">
              {t('settings.presets.promptVersion')}
            </FieldLabel>
            <Input
              id="preset-prompt-version"
              value={preset.promptVersion ?? ''}
              onChange={(event) => setPreset({ ...preset, promptVersion: event.target.value })}
            />
          </Field>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </FieldGroup>
      </CardContent>
      <CardFooter className="gap-2">
        <Button
          onClick={() => {
            setError(null);
            void onSave(preset).catch((saveError: unknown) =>
              setError(saveError instanceof Error ? saveError.message : String(saveError)),
            );
          }}
        >
          {t('settings.presets.save')}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          {t('app.cancel')}
        </Button>
      </CardFooter>
    </Card>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  ...inputProps
}: {
  id: string;
  label: string;
  value: number | undefined;
  min: number;
  max?: number;
  step: number;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        value={value ?? ''}
        onChange={(event) => onChange(optionalNumber(event.target.value))}
        {...inputProps}
      />
    </Field>
  );
}

function EnumField({
  id,
  label,
  value,
  values,
  getOptionLabel,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  values: readonly string[];
  getOptionLabel: (value: string) => string;
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {values.map((option) => (
              <SelectItem key={option} value={option}>
                {getOptionLabel(option)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}
