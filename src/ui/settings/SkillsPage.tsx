/**
 * Skills settings (docs/08 §3): list, enable/disable, import (paste/file/URL),
 * built-in CodeMirror editor with live frontmatter validation. Built on
 * shadcn/ui primitives; URL import uses a Dialog instead of window.prompt.
 */

import { useEffect, useState } from 'react';
import { Download, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { CodeEditor } from '../components/CodeEditor';
import { FilePickerButton } from '../components/FilePickerButton';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty';
import { Field, FieldError, FieldGroup, FieldLabel } from '../components/ui/field';
import { Alert, AlertAction, AlertDescription } from '../components/ui/alert';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemTitle,
} from '../components/ui/item';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { PanelotDB } from '../../db/schema';
import { SkillManager, SkillNameConflictError } from '../../skills/manager';
import { PluginManager } from '../../plugins/manager';
import { listSkillFileDependencies, parseSkill } from '../../skills/parse';
import type { SkillRecord } from '../../db/types';
import { hostPermissionBroker } from '../../permissions/hostPermissionBroker';
import { t } from '../i18n';

const db = new PanelotDB();
const manager = new SkillManager(db);
const pluginManager = new PluginManager(db);

function skillTemplate(): string {
  return `---
name: my-skill
description: ${t('settings.skills.templateDescription')}
panelot:
  sites: ["*.example.com"]
  auto_suggest: true
---
# ${t('settings.skills.templateHeading')}
${t('settings.skills.templateBody')}`;
}

export function SkillsPage() {
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [conflict, setConflict] = useState<{
    raw: string;
    source: SkillRecord['source'];
    sourceRef?: string;
  } | null>(null);

  const refresh = () => manager.list().then(setSkills);
  useEffect(() => void refresh(), []);

  const save = async () => {
    try {
      parseSkill(draft); // validate before saving
      await manager.importFromText(draft, 'user', undefined, {
        existingId: editing && editing !== 'new' ? editing : undefined,
      });
      setError(null);
      setEditing(null);
      await refresh();
      toast.success(t('settings.skills.saved'));
    } catch (e) {
      if (e instanceof SkillNameConflictError) {
        setConflict({ raw: draft, source: 'user' });
      }
      setError((e as Error).message);
    }
  };

  const onFile = async (file: File) => {
    const text = await file.text();
    const dependencies = listSkillFileDependencies(text);
    setError(
      dependencies.length > 0
        ? t('settings.skills.dependencyWarning', { files: dependencies.join(', ') })
        : null,
    );
    setDraft(text);
    setEditing('new');
  };

  const doImportUrl = async () => {
    const url = importUrl.trim();
    if (!url) return;
    let text = '';
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') throw new Error(t('settings.skills.httpsOnly'));
      if (!(await hostPermissionBroker.request(parsed.origin)))
        throw new Error(t('settings.skills.permissionDenied'));
      const response = await fetch(parsed.href);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      text = await response.text();
      if (new TextEncoder().encode(text).byteLength > 1024 * 1024)
        throw new Error(t('settings.skills.tooLarge'));
      const dependencies = listSkillFileDependencies(text);
      if (dependencies.length > 0) {
        toast.warning(t('settings.skills.externalFiles', { n: dependencies.length }));
      }
      await manager.importFromText(text, 'imported', url);
      await refresh();
      setUrlDialogOpen(false);
      setImportUrl('');
      toast.success(t('settings.skills.imported'));
    } catch (e) {
      if (e instanceof SkillNameConflictError && text) {
        setConflict({ raw: text, source: 'imported', sourceRef: url });
      }
      setError(t('settings.skills.importFailed', { error: (e as Error).message }));
      setUrlDialogOpen(false);
    }
  };

  const resolveConflict = async (mode: 'overwrite' | 'rename') => {
    if (!conflict) return;
    await manager.importFromText(conflict.raw, conflict.source, conflict.sourceRef, {
      conflict: mode,
    });
    setConflict(null);
    setEditing(null);
    setError(null);
    await refresh();
  };

  if (editing) {
    let preview: { name: string; description: string } | null = null;
    try {
      const p = parseSkill(draft);
      preview = { name: p.frontmatter.name, description: p.frontmatter.description };
    } catch {
      /* invalid while typing */
    }
    return (
      <div className="flex max-w-2xl flex-col gap-3">
        <h2 className="text-[15px] font-semibold">{t('settings.skills.edit')}</h2>
        <FieldGroup>
          <Field data-invalid={Boolean(error)}>
            <FieldLabel>{t('settings.skills.edit')}</FieldLabel>
            <CodeEditor
              value={draft}
              onChange={setDraft}
              placeholder={skillTemplate()}
              ariaLabel={t('settings.skills.edit')}
              ariaInvalid={Boolean(error)}
              ariaDescribedBy={error ? 'skill-editor-error' : undefined}
            />
            {error && <FieldError id="skill-editor-error">{error}</FieldError>}
          </Field>
        </FieldGroup>
        {preview && (
          <Alert variant="success">
            <AlertDescription>
              ✓ {preview.name} — {preview.description}
            </AlertDescription>
          </Alert>
        )}
        {conflict && (
          <Alert>
            <AlertDescription>{t('settings.skills.conflict')}</AlertDescription>
            <AlertAction placement="footer">
              <Button size="sm" onClick={() => void resolveConflict('overwrite')}>
                {t('settings.skills.overwrite')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void resolveConflict('rename')}>
                {t('settings.skills.rename')}
              </Button>
            </AlertAction>
          </Alert>
        )}
        <div className="flex gap-2">
          <Button size="sm" className="px-4" onClick={() => void save()}>
            {t('app.save')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditing(null);
              setError(null);
            }}
          >
            {t('app.cancel')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-[15px] font-semibold">Skills</h2>
        <div className="ml-auto flex gap-2">
          <FilePickerButton
            id="skill-file-import"
            label={t('settings.skills.importFileLabel')}
            accept=".md"
            onFile={(file) => void onFile(file)}
          >
            {t('settings.skills.importFile')}
          </FilePickerButton>
          <Button variant="outline" size="sm" onClick={() => setUrlDialogOpen(true)}>
            {t('settings.skills.importUrl')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setDraft(skillTemplate());
              setEditing('new');
            }}
          >
            <Plus data-icon="inline-start" /> {t('settings.skills.new')}
          </Button>
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {conflict && (
        <Alert>
          <AlertDescription>{t('settings.skills.conflict')}</AlertDescription>
          <AlertAction placement="footer">
            <Button size="sm" onClick={() => void resolveConflict('overwrite')}>
              {t('settings.skills.overwrite')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void resolveConflict('rename')}>
              {t('settings.skills.rename')}
            </Button>
          </AlertAction>
        </Alert>
      )}
      {skills.length === 0 ? (
        <Empty className="border border-dashed p-6 md:p-6">
          <EmptyHeader>
            <EmptyTitle className="text-base">{t('settings.skills.emptyTitle')}</EmptyTitle>
            <EmptyDescription>{t('settings.skills.emptyHint')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-2">
          {skills.map((s) => {
            const fm = s.frontmatter as {
              description: string;
              panelot?: { sites?: string[]; command?: string };
            };
            return (
              <Item key={s.id} variant="outline" size="sm">
                <ItemContent>
                  <ItemTitle>
                    <Switch
                      checked={s.enabled}
                      disabled={s.source === 'plugin'}
                      onCheckedChange={(on) => void manager.setEnabled(s.id, on).then(refresh)}
                      aria-label={s.name}
                    />
                    <span>{s.name}</span>
                    {fm.panelot?.command && (
                      <Badge variant="secondary" className="font-mono">
                        {fm.panelot.command}
                      </Badge>
                    )}
                  </ItemTitle>
                  <ItemDescription>{fm.description}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      if (s.source === 'plugin') {
                        void pluginManager.copyInstalledSkillToUser(s.id).then((copy) => {
                          setDraft(copy.raw);
                          setEditing(copy.id);
                          return refresh();
                        });
                      } else {
                        setDraft(s.raw);
                        setEditing(s.id);
                      }
                    }}
                  >
                    {s.source === 'plugin'
                      ? t('settings.skills.copyEdit')
                      : t('settings.providers.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t('settings.skills.export', { name: s.name })}
                    onClick={() => {
                      const url = URL.createObjectURL(new Blob([s.raw], { type: 'text/markdown' }));
                      const anchor = document.createElement('a');
                      anchor.href = url;
                      anchor.download = `${s.name}.SKILL.md`;
                      anchor.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    <Download data-icon="inline-start" />
                  </Button>
                  {s.source !== 'plugin' && (
                    <Button
                      variant="destructive"
                      size="xs"
                      onClick={() => void manager.remove(s.id).then(refresh)}
                    >
                      {t('settings.skills.delete')}
                    </Button>
                  )}
                </ItemActions>
                <ItemFooter>
                  <span>{s.source}</span>
                  {fm.panelot?.sites?.length ? (
                    <span className="ml-auto">[{fm.panelot.sites.join(', ')}]</span>
                  ) : null}
                </ItemFooter>
              </Item>
            );
          })}
        </ItemGroup>
      )}

      <Dialog open={urlDialogOpen} onOpenChange={setUrlDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.skills.urlTitle')}</DialogTitle>
            <DialogDescription>{t('settings.skills.urlHint')}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="skill-import-url">{t('settings.skills.urlTitle')}</FieldLabel>
              <Input
                id="skill-import-url"
                value={importUrl}
                onChange={(e) => setImportUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void doImportUrl()}
                placeholder="https://raw.githubusercontent.com/…/SKILL.md"
                className="font-mono"
                autoFocus
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setUrlDialogOpen(false)}>
              {t('app.cancel')}
            </Button>
            <Button size="sm" onClick={() => void doImportUrl()}>
              {t('settings.skills.import')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
