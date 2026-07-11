/**
 * Structured variable form for slash commands (docs/08 §4, OpenWebUI pattern):
 * VariableDef { key, label, type, options?, default?, required? } → dialog →
 * submit composes "/cmd" user text with {{key}} placeholders resolved.
 */

import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import type { SkillCommand } from './composerTriggers';

interface Props {
  command: SkillCommand | null;
  onClose: () => void;
  /** Called with the composed message text, e.g. "/xhs 标题：… 日期：…". */
  onSubmit: (text: string) => void;
}

export function SkillVariableForm({ command, onClose, onSubmit }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!command) return;
    const defaults: Record<string, string> = {};
    for (const v of command.variables ?? []) {
      if (v.default !== undefined) defaults[v.key] = v.default;
    }
    setValues(defaults);
  }, [command]);

  if (!command) return null;

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
        <div className="space-y-3">
          {(command.variables ?? []).map((v) => (
            <div key={v.key} className="space-y-1.5">
              <Label htmlFor={`var-${v.key}`} className="text-[12px] text-muted-foreground">
                {v.label}
                {v.required && <span className="text-destructive"> *</span>}
              </Label>
              {v.type === 'select' && v.options ? (
                <Select
                  value={values[v.key] ?? ''}
                  onValueChange={(val) => setValues((s) => ({ ...s, [v.key]: val }))}
                >
                  <SelectTrigger id={`var-${v.key}`} className="w-full">
                    <SelectValue placeholder="选择…" />
                  </SelectTrigger>
                  <SelectContent>
                    {v.options.map((o) => (
                      <SelectItem key={o} value={o}>
                        {o}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={`var-${v.key}`}
                  type={v.type === 'date' ? 'date' : v.type === 'url' ? 'url' : 'text'}
                  value={values[v.key] ?? ''}
                  onChange={(e) => setValues((s) => ({ ...s, [v.key]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                />
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" disabled={missing.length > 0} onClick={submit}>
            发送
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
