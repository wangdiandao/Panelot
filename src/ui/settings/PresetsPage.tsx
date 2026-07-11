import { useEffect, useState } from 'react';
import { Bot, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PanelotDB } from '../../db/schema';
import type { SkillRecord } from '../../db/types';
import type { Connection, GenParams, ModelPreset } from '../../providers/types';
import { upsertModelPreset } from '../../settings/presets';
import { SettingsStore, type GlobalSettings } from '../../settings/store';
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
  FieldError,
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

const db = new PanelotDB();
const TOOL_LEVELS = ['L0', 'L1', 'L2', 'mcp'] as const;

function createPreset(): ModelPreset {
  return {
    id: crypto.randomUUID(),
    name: '',
    base: { connectionId: '', modelId: '' },
    enabledToolLevels: [...TOOL_LEVELS],
    defaultApprovalPolicy: 'untrusted',
    defaultCapabilityScope: 'full',
    skills: [],
    promptVersion: 'kernel',
  };
}

function optionalNumber(value: string): number | undefined {
  return value.trim() ? Number(value) : undefined;
}

export function PresetsPage() {
  const [presets, setPresets] = useState<ModelPreset[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [global, setGlobal] = useState<GlobalSettings>({});
  const [pluginPresets, setPluginPresets] = useState<PluginPresetAsset[]>([]);
  const [editing, setEditing] = useState<ModelPreset | null>(null);
  const [deleting, setDeleting] = useState<ModelPreset | null>(null);

  useEffect(() => {
    void Promise.all([
      SettingsStore.presets.get(),
      SettingsStore.connections.get(),
      db.skills.where('enabled').equals(1).toArray(),
      SettingsStore.global.get(),
      listEnabledPluginPresets(db),
    ]).then(([storedPresets, storedConnections, enabledSkills, storedGlobal, installedPresets]) => {
      setPresets(storedPresets);
      setConnections(storedConnections.filter((connection) => connection.enabled));
      setSkills(enabledSkills);
      setGlobal(storedGlobal);
      setPluginPresets(installedPresets);
    });
  }, []);

  const persist = async (next: ModelPreset[]) => {
    setPresets(next);
    await SettingsStore.presets.set(next);
  };

  const updateTaskModel = async (choice: { connectionId: string; modelId: string } | null) => {
    const next = { ...global, taskModel: choice ?? undefined };
    setGlobal(next);
    await SettingsStore.global.set(next);
    toast.success(choice ? `Task model: ${choice.modelId}` : 'Task model follows the default');
  };

  if (editing) {
    return (
      <PresetForm
        preset={editing}
        connections={connections}
        skills={skills}
        onCancel={() => setEditing(null)}
        onSave={async (candidate) => {
          await persist(upsertModelPreset(presets, candidate));
          setEditing(null);
          toast.success('Preset saved');
        }}
      />
    );
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex items-start gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">Model presets</h2>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Pin model, prompt, tools, and approval policy into an auditable agent profile.
          </p>
        </div>
        <Button className="ml-auto" size="sm" onClick={() => setEditing(createPreset())}>
          <Plus data-icon="inline-start" />
          New preset
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Task model</CardTitle>
          <CardDescription>
            Used for titles and other low-cost background tasks. Empty follows the default model.
          </CardDescription>
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
            <EmptyTitle>No model presets yet</EmptyTitle>
            <EmptyDescription>
              Create one to give new chats a consistent model, parameters, and capability boundary.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={() => setEditing(createPreset())}>
              <Plus data-icon="inline-start" />
              New preset
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
                    Edit
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>{(preset.enabledToolLevels ?? TOOL_LEVELS).join(', ')}</span>
                <Separator orientation="vertical" className="h-4" />
                <span>{preset.defaultApprovalPolicy ?? 'untrusted'}</span>
                <Separator orientation="vertical" className="h-4" />
                <span>{preset.defaultCapabilityScope ?? 'full'}</span>
              </CardContent>
              <CardFooter>
                <Button variant="ghost" size="sm" onClick={() => setDeleting(preset)}>
                  <Trash2 data-icon="inline-start" />
                  Delete
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {pluginPresets.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">Plugin presets</h3>
          {pluginPresets.map((asset) => (
            <Card key={`${asset.assetId}:${asset.preset.id}`}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  {asset.preset.name}
                  <Badge variant="outline">{asset.pluginId}</Badge>
                </CardTitle>
                <CardDescription>
                  {asset.preset.base.connectionId} · {asset.preset.base.modelId} · read-only
                </CardDescription>
                <CardAction>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setEditing({
                        ...asset.preset,
                        id: crypto.randomUUID(),
                        name: `${asset.preset.name} copy`,
                      })
                    }
                  >
                    Copy and edit
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
            <AlertDialogTitle>Delete this model preset?</AlertDialogTitle>
            <AlertDialogDescription>
              Existing chat records remain, but this preset can no longer be selected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) void persist(presets.filter((preset) => preset.id !== deleting.id));
                setDeleting(null);
              }}
            >
              Delete
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
        <CardTitle>{initialPreset.name ? 'Edit preset' : 'Create model preset'}</CardTitle>
        <CardDescription>
          Every field is persisted into the resolved run environment.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <div className="grid grid-cols-[1fr_9rem] gap-4">
            <Field data-invalid={Boolean(error && !preset.name.trim())}>
              <FieldLabel htmlFor="preset-name">Name</FieldLabel>
              <Input
                id="preset-name"
                value={preset.name}
                aria-invalid={Boolean(error && !preset.name.trim())}
                onChange={(event) => setPreset({ ...preset, name: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="preset-icon">Icon or emoji</FieldLabel>
              <Input
                id="preset-icon"
                value={preset.icon ?? ''}
                onChange={(event) => setPreset({ ...preset, icon: event.target.value })}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel>Connection</FieldLabel>
              <Select
                value={preset.base.connectionId || undefined}
                onValueChange={(connectionId) =>
                  setPreset({ ...preset, base: { ...preset.base, connectionId } })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a connection" />
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
              <FieldLabel htmlFor="preset-model">Model ID</FieldLabel>
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
            <FieldLabel htmlFor="preset-prompt">System prompt</FieldLabel>
            <Textarea
              id="preset-prompt"
              rows={6}
              value={preset.systemPrompt ?? ''}
              onChange={(event) => setPreset({ ...preset, systemPrompt: event.target.value })}
            />
          </Field>

          <FieldSet>
            <FieldLegend variant="label">Generation parameters</FieldLegend>
            <FieldGroup className="grid grid-cols-2 gap-4">
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
                label="Maximum output tokens"
                value={preset.params?.maxTokens}
                min={1}
                step={1}
                onChange={(value) => updateParams({ maxTokens: value })}
              />
              <Field>
                <FieldLabel>Reasoning effort</FieldLabel>
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
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="unset">Not set</SelectItem>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
          </FieldSet>

          <Field>
            <FieldLabel htmlFor="preset-stop">Stop sequences, one per line</FieldLabel>
            <Textarea
              id="preset-stop"
              rows={3}
              value={preset.params?.stopSequences?.join('\n') ?? ''}
              onChange={(event) => updateParams({ stopSequences: event.target.value.split('\n') })}
            />
          </Field>

          <FieldSet>
            <FieldLegend variant="label">Enabled tool levels</FieldLegend>
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
              aria-label="Enabled tool levels"
            >
              {TOOL_LEVELS.map((level) => (
                <ToggleGroupItem key={level} value={level} aria-label={level}>
                  {level}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>L0 read · L1 page write · L2 debugger · MCP</FieldDescription>
          </FieldSet>

          <div className="grid grid-cols-2 gap-4">
            <EnumField
              label="Default approval policy"
              value={preset.defaultApprovalPolicy ?? 'untrusted'}
              values={['always', 'untrusted', 'on-request', 'granular', 'auto', 'never']}
              onChange={(value) =>
                setPreset({
                  ...preset,
                  defaultApprovalPolicy: value as ModelPreset['defaultApprovalPolicy'],
                })
              }
            />
            <EnumField
              label="Default capability scope"
              value={preset.defaultCapabilityScope ?? 'full'}
              values={['read-only', 'same-origin-write', 'cross-origin', 'full']}
              onChange={(value) =>
                setPreset({
                  ...preset,
                  defaultCapabilityScope: value as ModelPreset['defaultCapabilityScope'],
                })
              }
            />
          </div>

          <FieldSet>
            <FieldLegend variant="label">Active Skills</FieldLegend>
            <FieldGroup className="gap-3">
              {skills.length === 0 && <FieldDescription>No enabled Skills</FieldDescription>}
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
            <FieldLabel htmlFor="preset-prompt-version">Prompt version</FieldLabel>
            <Input
              id="preset-prompt-version"
              value={preset.promptVersion ?? ''}
              onChange={(event) => setPreset({ ...preset, promptVersion: event.target.value })}
            />
          </Field>

          {error && <FieldError>{error}</FieldError>}
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
          Save preset
        </Button>
        <Button variant="outline" onClick={onCancel}>
          Cancel
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
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string;
  values: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {values.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}
