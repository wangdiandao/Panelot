/**
 * Structured variable form for slash commands (docs/development/skills-plugins.md §4, OpenWebUI pattern):
 * VariableDef { key, label, type, options?, default?, required? } → dialog →
 * submit composes "/cmd" user text with {{key}} placeholders resolved.
 */

import { useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Field, FieldGroup, FieldLabel } from './ui/field';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import type { SkillCommand } from './composerTriggers';
import { t } from '../i18n';

interface Props {
  command: SkillCommand | null;
  onClose: () => void;
  /** Called with the composed message text, e.g. "/xhs 标题：… 日期：…". */
  onSubmit: (text: string) => void;
}

export function SkillVariableForm({ command, onClose, onSubmit }: Props) {
  if (!command) return null;

  return (
    <SkillVariableDialog
      key={`${command.skillName}:${command.command}`}
      command={command}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}

function initialValues(command: SkillCommand): Record<string, string> {
  return Object.fromEntries(
    (command.variables ?? [])
      .filter((variable) => variable.default !== undefined)
      .map((variable) => [variable.key, variable.default ?? '']),
  );
}

function SkillVariableDialog({
  command,
  onClose,
  onSubmit,
}: Omit<Props, 'command'> & { command: SkillCommand }) {
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(command));

  const missing = (command.variables ?? []).filter((v) => v.required && !values[v.key]?.trim());

  const submit = () => {
    if (missing.length > 0) return;
    const args = (command.variables ?? [])
      .map((v) => `${v.label}: ${values[v.key] ?? ''}`)
      .join('\n');
    onSubmit(`${command.command}\n${args}`);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono text-[15px]">{command.command}</DialogTitle>
          <DialogDescription>{command.description}</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          {(command.variables ?? []).map((v) => (
            <Field key={v.key}>
              <FieldLabel htmlFor={`var-${v.key}`}>
                {v.label}
                {v.required && <span className="text-destructive"> *</span>}
              </FieldLabel>
              {v.type === 'select' && v.options ? (
                <Select
                  value={values[v.key] ?? ''}
                  onValueChange={(val) => setValues((s) => ({ ...s, [v.key]: val }))}
                >
                  <SelectTrigger id={`var-${v.key}`} className="w-full" aria-required={v.required}>
                    <SelectValue placeholder={t('skills.variableSelect')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {v.options.map((o) => (
                        <SelectItem key={o} value={o}>
                          {o}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={`var-${v.key}`}
                  type={v.type === 'date' ? 'date' : v.type === 'url' ? 'url' : 'text'}
                  required={v.required}
                  value={values[v.key] ?? ''}
                  onChange={(e) => setValues((s) => ({ ...s, [v.key]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                />
              )}
            </Field>
          ))}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button size="sm" disabled={missing.length > 0} onClick={submit}>
            {t('input.send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
