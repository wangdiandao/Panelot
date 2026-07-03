/**
 * Skills settings (docs/08 §3): list, enable/disable, import (paste/file/URL),
 * built-in editor. CodeMirror is deferred; a plain textarea with live
 * validation covers the editing contract.
 */

import { useEffect, useState } from 'react';
import { PanelotDB } from '../../db/schema';
import { SkillManager } from '../../skills/manager';
import { parseSkill } from '../../skills/parse';
import type { SkillRecord } from '../../db/types';

const db = new PanelotDB();
const manager = new SkillManager(db);

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

  const refresh = () => manager.list().then(setSkills);
  useEffect(() => void refresh(), []);

  const save = async () => {
    try {
      parseSkill(draft); // validate before saving
      await manager.importFromText(draft, 'user');
      setError(null);
      setEditing(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onFile = async (file: File) => {
    const text = await file.text();
    setDraft(text);
    setEditing('new');
  };

  const onImportUrl = async () => {
    const url = prompt('输入 SKILL.md 的 URL（GitHub raw 等）:');
    if (!url) return;
    try {
      const text = await (await fetch(url)).text();
      await manager.importFromText(text, 'imported', url);
      await refresh();
    } catch (e) {
      setError(`导入失败: ${(e as Error).message}`);
    }
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
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={20}
          className="w-full rounded-md border border-border bg-muted p-3 font-mono text-[12.5px] outline-none focus:border-primary/60"
        />
        {preview && <div className="text-[12px] text-success">✓ {preview.name} — {preview.description}</div>}
        {error && <div className="text-[12px] text-destructive">{error}</div>}
        <div className="flex gap-2">
          <button type="button" onClick={() => void save()} className="rounded-md bg-primary px-4 py-1.5 text-[12.5px] font-medium text-black hover:brightness-110">保存</button>
          <button type="button" onClick={() => { setEditing(null); setError(null); }} className="rounded-md border border-border px-3 py-1.5 text-[12.5px] hover:bg-muted">取消</button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-[15px] font-semibold">Skills</h2>
        <div className="ml-auto flex gap-2">
          <label className="cursor-pointer rounded-md border border-border px-3 py-1 text-[12.5px] hover:bg-muted">
            导入文件
            <input type="file" accept=".md" className="hidden" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
          </label>
          <button type="button" onClick={() => void onImportUrl()} className="rounded-md border border-border px-3 py-1 text-[12.5px] hover:bg-muted">从 URL 导入</button>
          <button type="button" onClick={() => { setDraft(TEMPLATE); setEditing('new'); }} className="rounded-md bg-primary px-3 py-1 text-[12.5px] font-medium text-black hover:brightness-110">✚ 新建</button>
        </div>
      </div>
      {error && <div className="text-[12px] text-destructive">{error}</div>}
      {skills.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-border p-6 text-center text-[13px] text-muted-foreground">
          还没有 Skill。新建一个，或从社区导入兼容 Claude Code 的 SKILL.md。
        </div>
      ) : (
        skills.map((s) => {
          const fm = s.frontmatter as { description: string; panelot?: { sites?: string[]; command?: string } };
          return (
            <div key={s.id} className="rounded-[10px] border border-border bg-card px-4 py-3">
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={s.enabled} onChange={(e) => void manager.setEnabled(s.id, e.target.checked).then(refresh)} />
                <span className="font-medium text-[13px]">{s.name}</span>
                {fm.panelot?.command && <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">{fm.panelot.command}</span>}
                {fm.panelot?.sites?.length ? <span className="text-[11px] text-muted-foreground">[{fm.panelot.sites.join(', ')}]</span> : null}
                <span className="ml-auto text-[11px] text-muted-foreground">{s.source}</span>
                <button type="button" onClick={() => { setDraft(s.raw); setEditing(s.id); }} className="text-[11px] text-muted-foreground hover:text-foreground">编辑</button>
                <button type="button" onClick={() => void manager.remove(s.id).then(refresh)} className="text-[11px] text-muted-foreground hover:text-destructive">删除</button>
              </div>
              <div className="mt-1 text-[12px] text-muted-foreground">{fm.description}</div>
            </div>
          );
        })
      )}
    </div>
  );
}
