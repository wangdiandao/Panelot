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

const db = new PanelotDB();
const manager = new SkillManager(db);
const pluginManager = new PluginManager(db);

const TEMPLATE = `---
name: my-skill
description: 简述这个技能做什么，以及何时使用。
panelot:
  sites: ["*.example.com"]
  auto_suggest: true
---
# 指令正文
在这里写详细指令。`;

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
      toast.success('Skill 已保存');
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
        ? `该 Skill 引用了 ${dependencies.join('、')}；单文件导入不会包含这些依赖，请确认指令仍可独立使用。`
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
      if (parsed.protocol !== 'https:') throw new Error('Skill URL 必须使用 HTTPS');
      if (!(await hostPermissionBroker.request(parsed.origin)))
        throw new Error('未授予该 URL 的访问权限');
      const response = await fetch(parsed.href);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      text = await response.text();
      if (new TextEncoder().encode(text).byteLength > 1024 * 1024)
        throw new Error('SKILL.md 超过 1 MB 限制');
      const dependencies = listSkillFileDependencies(text);
      if (dependencies.length > 0) {
        toast.warning(`该 Skill 还引用 ${dependencies.length} 个外部文件，当前仅导入 SKILL.md`);
      }
      await manager.importFromText(text, 'imported', url);
      await refresh();
      setUrlDialogOpen(false);
      setImportUrl('');
      toast.success('已从 URL 导入');
    } catch (e) {
      if (e instanceof SkillNameConflictError && text) {
        setConflict({ raw: text, source: 'imported', sourceRef: url });
      }
      setError(`导入失败: ${(e as Error).message}`);
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
      <div className="max-w-2xl space-y-3">
        <h2 className="text-[15px] font-semibold">编辑 Skill</h2>
        <CodeEditor value={draft} onChange={setDraft} placeholder={TEMPLATE} />
        {preview && (
          <div className="text-[12px] text-success">
            ✓ {preview.name} — {preview.description}
          </div>
        )}
        {error && <div className="text-[12px] text-destructive">{error}</div>}
        {conflict && (
          <div className="flex gap-2 rounded-lg border border-border p-3">
            <Button size="sm" onClick={() => void resolveConflict('overwrite')}>
              覆盖同名 Skill
            </Button>
            <Button variant="outline" size="sm" onClick={() => void resolveConflict('rename')}>
              自动改名
            </Button>
          </div>
        )}
        <div className="flex gap-2">
          <Button size="sm" className="px-4" onClick={() => void save()}>
            保存
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditing(null);
              setError(null);
            }}
          >
            取消
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-[15px] font-semibold">Skills</h2>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <label className="cursor-pointer">
              导入文件
              <input
                type="file"
                accept=".md"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])}
              />
            </label>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setUrlDialogOpen(true)}>
            从 URL 导入
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setDraft(TEMPLATE);
              setEditing('new');
            }}
          >
            <Plus /> 新建
          </Button>
        </div>
      </div>
      {error && <div className="text-[12px] text-destructive">{error}</div>}
      {conflict && (
        <div className="flex gap-2 rounded-lg border border-border p-3">
          <Button size="sm" onClick={() => void resolveConflict('overwrite')}>
            覆盖同名 Skill
          </Button>
          <Button variant="outline" size="sm" onClick={() => void resolveConflict('rename')}>
            自动改名
          </Button>
        </div>
      )}
      {skills.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-[13px] text-muted-foreground">
          还没有 Skill。新建一个，或从社区导入兼容 Claude Code 的 SKILL.md。
        </div>
      ) : (
        skills.map((s) => {
          const fm = s.frontmatter as {
            description: string;
            panelot?: { sites?: string[]; command?: string };
          };
          return (
            <div key={s.id} className="rounded-lg border border-border bg-card px-4 py-3">
              <div className="flex items-center gap-2">
                <Switch
                  checked={s.enabled}
                  disabled={s.source === 'plugin'}
                  onCheckedChange={(on) => void manager.setEnabled(s.id, on).then(refresh)}
                  aria-label={`启用 ${s.name}`}
                />
                <span className="text-[13px] font-medium">{s.name}</span>
                {fm.panelot?.command && (
                  <Badge
                    variant="secondary"
                    className="font-mono text-[11px] text-muted-foreground"
                  >
                    {fm.panelot.command}
                  </Badge>
                )}
                {fm.panelot?.sites?.length ? (
                  <span className="text-[11px] text-muted-foreground">
                    [{fm.panelot.sites.join(', ')}]
                  </span>
                ) : null}
                <span className="ml-auto text-[11px] text-muted-foreground">{s.source}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[12px] text-muted-foreground"
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
                  {s.source === 'plugin' ? '复制并编辑' : '编辑'}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground"
                  aria-label={`导出 ${s.name}`}
                  onClick={() => {
                    const url = URL.createObjectURL(new Blob([s.raw], { type: 'text/markdown' }));
                    const anchor = document.createElement('a');
                    anchor.href = url;
                    anchor.download = `${s.name}.SKILL.md`;
                    anchor.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  <Download className="size-3" />
                </Button>
                {s.source !== 'plugin' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[12px] text-muted-foreground hover:text-destructive"
                    onClick={() => void manager.remove(s.id).then(refresh)}
                  >
                    删除
                  </Button>
                )}
              </div>
              <div className="mt-1 text-[12px] text-muted-foreground">{fm.description}</div>
            </div>
          );
        })
      )}

      <Dialog open={urlDialogOpen} onOpenChange={setUrlDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>从 URL 导入 Skill</DialogTitle>
            <DialogDescription>输入 SKILL.md 的 URL（GitHub raw 等）。</DialogDescription>
          </DialogHeader>
          <Input
            value={importUrl}
            onChange={(e) => setImportUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void doImportUrl()}
            placeholder="https://raw.githubusercontent.com/…/SKILL.md"
            className="font-mono"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setUrlDialogOpen(false)}>
              取消
            </Button>
            <Button size="sm" onClick={() => void doImportUrl()}>
              导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
