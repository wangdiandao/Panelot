import { useEffect, useState } from 'react';
import { Globe2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { SiteInstruction } from '../../settings/sitePrompts';
import { normalizeSiteInstructions } from '../../settings/sitePrompts';
import { SettingsStore } from '../../settings/store';
import {
  listEnabledPluginSiteInstructions,
  type PluginSiteInstruction,
} from '../../plugins/assets';
import { PanelotDB } from '../../db/schema';
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
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../components/ui/input-group';
import { Textarea } from '../components/ui/textarea';
import { t } from '../i18n';

type EditableInstruction = SiteInstruction & { originalPattern?: string };
const db = new PanelotDB();

export function SiteInstructionsPage() {
  const [entries, setEntries] = useState<SiteInstruction[]>([]);
  const [editing, setEditing] = useState<EditableInstruction | null>(null);
  const [deleting, setDeleting] = useState<SiteInstruction | null>(null);
  const [pluginEntries, setPluginEntries] = useState<PluginSiteInstruction[]>([]);

  useEffect(() => {
    void Promise.all([SettingsStore.sitePrompts.get(), listEnabledPluginSiteInstructions(db)]).then(
      ([stored, installed]) => {
        setEntries(stored);
        setPluginEntries(installed);
      },
    );
  }, []);

  const persist = async (next: SiteInstruction[]) => {
    const normalized = normalizeSiteInstructions(next);
    setEntries(normalized);
    await SettingsStore.sitePrompts.set(normalized);
  };

  if (editing) {
    return (
      <InstructionForm
        instruction={editing}
        onCancel={() => setEditing(null)}
        onSave={async (candidate) => {
          const withoutOriginal = entries.filter(
            (entry) => entry.pattern !== editing.originalPattern,
          );
          await persist([...withoutOriginal, candidate]);
          setEditing(null);
          toast.success(t('settings.sites.saved'));
        }}
      />
    );
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex items-start gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">{t('settings.sites.title')}</h2>
          <p className="mt-1 text-[12px] text-muted-foreground">{t('settings.sites.summary')}</p>
        </div>
        <Button
          className="ml-auto"
          size="sm"
          onClick={() => setEditing({ pattern: '', prompt: '' })}
        >
          <Plus data-icon="inline-start" />
          {t('settings.sites.new')}
        </Button>
      </div>

      {entries.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Globe2 />
            </EmptyMedia>
            <EmptyTitle>{t('settings.sites.emptyTitle')}</EmptyTitle>
            <EmptyDescription>{t('settings.sites.emptyHint')}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={() => setEditing({ pattern: '', prompt: '' })}>
              <Plus data-icon="inline-start" />
              {t('settings.sites.new')}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {entries.map((entry) => (
            <Card key={entry.pattern}>
              <CardHeader>
                <CardTitle className="font-mono text-sm">{entry.pattern}</CardTitle>
                <CardDescription className="line-clamp-2 whitespace-pre-wrap">
                  {entry.prompt}
                </CardDescription>
                <CardAction>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditing({ ...entry, originalPattern: entry.pattern })}
                  >
                    {t('settings.sites.edit')}
                  </Button>
                </CardAction>
              </CardHeader>
              <CardFooter>
                <Button variant="destructive" size="sm" onClick={() => setDeleting(entry)}>
                  <Trash2 data-icon="inline-start" />
                  {t('settings.sites.delete')}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {pluginEntries.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">{t('settings.sites.pluginTitle')}</h3>
          {pluginEntries.map((entry) => (
            <Card key={`${entry.assetId}:${entry.pattern}`}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 font-mono text-sm">
                  {entry.pattern}
                  <Badge variant="outline">{entry.pluginId}</Badge>
                </CardTitle>
                <CardDescription className="line-clamp-2 whitespace-pre-wrap">
                  {entry.prompt}
                </CardDescription>
                <CardAction>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditing({ pattern: entry.pattern, prompt: entry.prompt })}
                  >
                    {t('settings.sites.copyEdit')}
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
            <AlertDialogTitle>{t('settings.sites.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.sites.deleteHint')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('app.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting)
                  void persist(entries.filter((entry) => entry.pattern !== deleting.pattern));
                setDeleting(null);
              }}
            >
              {t('settings.sites.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function InstructionForm({
  instruction,
  onSave,
  onCancel,
}: {
  instruction: EditableInstruction;
  onSave: (instruction: SiteInstruction) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(instruction);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>
          {instruction.originalPattern
            ? t('settings.sites.editTitle')
            : t('settings.sites.createTitle')}
        </CardTitle>
        <CardDescription>{t('settings.sites.patternHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field data-invalid={Boolean(error && !draft.pattern.trim())}>
            <FieldLabel htmlFor="site-pattern">{t('settings.sites.hostname')}</FieldLabel>
            <InputGroup>
              <InputGroupInput
                id="site-pattern"
                className="font-mono"
                value={draft.pattern}
                placeholder="*.example.com"
                aria-invalid={Boolean(error && !draft.pattern.trim())}
                onChange={(event) => setDraft({ ...draft, pattern: event.target.value })}
              />
              <InputGroupAddon align="inline-end">
                <Globe2 />
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription>{t('settings.sites.hostnameHint')}</FieldDescription>
          </Field>
          <Field data-invalid={Boolean(error && !draft.prompt.trim())}>
            <FieldLabel htmlFor="site-prompt">{t('settings.sites.instruction')}</FieldLabel>
            <Textarea
              id="site-prompt"
              rows={8}
              value={draft.prompt}
              aria-invalid={Boolean(error && !draft.prompt.trim())}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
          </Field>
          {error && <FieldError>{error}</FieldError>}
        </FieldGroup>
      </CardContent>
      <CardFooter className="gap-2">
        <Button
          onClick={() => {
            setError(null);
            void onSave({ pattern: draft.pattern, prompt: draft.prompt }).catch(
              (saveError: unknown) =>
                setError(saveError instanceof Error ? saveError.message : String(saveError)),
            );
          }}
        >
          {t('settings.sites.save')}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          {t('app.cancel')}
        </Button>
      </CardFooter>
    </Card>
  );
}
