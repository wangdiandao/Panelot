/**
 * Data sources for the TriggerMenu (docs/09 §5):
 *   @  → page / selection / screenshot / open tabs
 *   /  → built-in commands + Skill commands (panelot.command)
 *   {{ → dynamic variables, evaluated at submit time
 * MCP Prompts join the / list with the command palette phase (S5).
 */

import { useEffect, useState } from 'react';
import type { ContextBlock } from '../../messaging/protocol';
import {
  attachCurrentPage,
  attachScreenshot,
  attachSelection,
  attachTab,
  listAttachableTabs,
} from '../pageContext';
import { PanelotDB } from '../../db/schema';
import { SkillManager } from '../../skills/manager';
import type { SkillFrontmatter, VariableDef } from '../../skills/parse';
import type { TriggerItem, TriggerState } from './TriggerMenu';

const db = new PanelotDB();
const skillManager = new SkillManager(db);

export const DYNAMIC_VARIABLES = ['PAGE_URL', 'PAGE_TITLE', 'SELECTION', 'CLIPBOARD', 'CURRENT_DATE'] as const;

/** Evaluate {{VAR}} placeholders at submit time (docs/09 §5). */
export async function evaluateVariables(text: string): Promise<string> {
  if (!/\{\{(PAGE_URL|PAGE_TITLE|SELECTION|CLIPBOARD|CURRENT_DATE)\}\}/.test(text)) return text;
  const values = new Map<string, string>();
  values.set('CURRENT_DATE', new Date().toISOString().slice(0, 10));
  if (text.includes('{{PAGE_URL}}') || text.includes('{{PAGE_TITLE}}')) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      values.set('PAGE_URL', tab?.url ?? '');
      values.set('PAGE_TITLE', tab?.title ?? '');
    } catch { /* non-extension env */ }
  }
  if (text.includes('{{SELECTION}}')) {
    const sel = await attachSelection();
    const first = sel?.content[0];
    values.set('SELECTION', first?.type === 'text' ? first.text : '');
  }
  if (text.includes('{{CLIPBOARD}}')) {
    try {
      values.set('CLIPBOARD', await navigator.clipboard.readText());
    } catch {
      values.set('CLIPBOARD', '');
    }
  }
  return text.replace(/\{\{(PAGE_URL|PAGE_TITLE|SELECTION|CLIPBOARD|CURRENT_DATE)\}\}/g, (_, k: string) => values.get(k) ?? '');
}

export interface SkillCommand {
  command: string;
  skillName: string;
  description: string;
  variables?: VariableDef[];
}

export interface BuiltinCommand {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

interface Callbacks {
  attachContext: (block: ContextBlock) => void;
  /** Replace the active trigger text with `replacement` in the input. */
  replaceTrigger: (replacement: string) => void;
  /** Open the variable form for a skill command. */
  openVariableForm: (cmd: SkillCommand) => void;
  builtinCommands: BuiltinCommand[];
}

/** Assemble TriggerMenu items for the active trigger. */
export function useTriggerItems(trigger: TriggerState | null, cb: Callbacks): TriggerItem[] {
  const [tabs, setTabs] = useState<{ id: number; title: string; url: string }[]>([]);
  const [skillCommands, setSkillCommands] = useState<SkillCommand[]>([]);

  useEffect(() => {
    if (trigger?.kind !== '@') return;
    void listAttachableTabs().then(setTabs);
  }, [trigger?.kind]);

  useEffect(() => {
    if (trigger?.kind !== '/') return;
    void skillManager.list().then((skills) => {
      const cmds: SkillCommand[] = [];
      for (const s of skills) {
        if (!s.enabled) continue;
        const fm = s.frontmatter as SkillFrontmatter;
        if (fm.panelot?.command) {
          cmds.push({
            command: fm.panelot.command,
            skillName: s.name,
            description: fm.description,
            variables: fm.panelot.variables,
          });
        }
      }
      setSkillCommands(cmds);
    });
  }, [trigger?.kind]);

  if (!trigger) return [];

  if (trigger.kind === '@') {
    const attach = (fn: () => Promise<ContextBlock | null>) => async () => {
      cb.replaceTrigger('');
      const block = await fn();
      if (block) cb.attachContext(block);
    };
    return [
      { id: 'page', kind: '@', group: '上下文', label: '当前页面正文', icon: 'page', action: attach(attachCurrentPage) },
      { id: 'selection', kind: '@', group: '上下文', label: '当前选中文本', icon: 'selection', action: attach(attachSelection) },
      { id: 'screenshot', kind: '@', group: '上下文', label: '截图当前页', icon: 'screenshot', action: attach(attachScreenshot) },
      ...tabs.map((t) => ({
        id: `tab-${t.id}`,
        kind: '@' as const,
        group: '打开的标签页',
        label: t.title,
        hint: new URL(t.url).hostname,
        icon: 'tab' as const,
        action: attach(() => attachTab(t.id, t.url)),
      })),
    ];
  }

  if (trigger.kind === '/') {
    return [
      ...cb.builtinCommands.map((c) => ({
        id: c.id,
        kind: '/' as const,
        group: '内置命令',
        label: c.id,
        hint: c.hint,
        icon: 'command' as const,
        action: () => {
          cb.replaceTrigger('');
          c.run();
        },
      })),
      ...skillCommands.map((c) => ({
        id: c.command,
        kind: '/' as const,
        group: 'Skill 命令',
        label: c.command,
        hint: c.description,
        icon: 'command' as const,
        action: () => {
          if (c.variables?.length) {
            cb.replaceTrigger('');
            cb.openVariableForm(c);
          } else {
            cb.replaceTrigger(`${c.command} `);
          }
        },
      })),
    ];
  }

  // '{{' — dynamic variables
  return DYNAMIC_VARIABLES.map((v) => ({
    id: v,
    kind: '{{' as const,
    group: '动态变量（发送时求值）',
    label: `{{${v}}}`,
    icon: 'variable' as const,
    action: () => cb.replaceTrigger(`{{${v}}} `),
  }));
}
